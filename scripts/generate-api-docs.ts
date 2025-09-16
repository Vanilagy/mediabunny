// This script has been 100% vibe-coded with Claude (and Gemini!), meaning I literally haven't looked at any of the
// code. It's probably a mess, but it solves a one-off problem where only the output matters, and the output is indeed
// good, which is the point of a custom script for this: full, precise control.

/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @stylistic/max-len */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @stylistic/brace-style */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

const generateDocs = (entryFiles: string[], apiConfigFile: string, dry = false) => {
	const program = ts.createProgram(entryFiles, {
		target: ts.ScriptTarget.ES2020,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Node10,
		allowJs: false,
		declaration: true,
		esModuleInterop: true,
		skipLibCheck: true,
		strict: true,
	});

	const sourceFiles = entryFiles.map((entryFile) => {
		const sourceFile = program.getSourceFile(entryFile);
		if (!sourceFile) {
			throw new Error(`Could not find source file: ${entryFile}`);
		}
		return sourceFile;
	});

	const typeChecker = program.getTypeChecker();
	const outputDir = path.resolve(process.cwd(), 'docs/api');

	// Load API config
	const apiConfigPath = path.resolve(process.cwd(), apiConfigFile);
	if (!fs.existsSync(apiConfigPath)) {
		throw new Error(`API config file not found: ${apiConfigPath}`);
	}
	const apiConfig: Record<string, string> = JSON.parse(fs.readFileSync(apiConfigPath, 'utf-8'));

	// Extract special fields
	const headingText = apiConfig['heading'] || 'API Reference';
	const introText = apiConfig['intro'];

	// Create a copy without the special fields for group processing
	const groupConfig = { ...apiConfig };
	delete groupConfig['heading'];
	delete groupConfig['intro'];

	// Clear and recreate output directory (skip if dry run)
	if (!dry) {
		if (fs.existsSync(outputDir)) {
			fs.rmSync(outputDir, { recursive: true });
		}
		fs.mkdirSync(outputDir, { recursive: true });
	}

	// Collect all exported types for cross-referencing
	const exportedTypes = new Set<string>();
	const classHierarchy = new Map<string, string[]>(); // Maps parent class to array of subclasses
	const classInstances = new Map<string, string[]>(); // Maps class name to array of instance variable names

	const collectExportedTypes = (module: ts.Symbol, visited = new Set<ts.Symbol>()): void => {
		if (visited.has(module)) return;
		visited.add(module);

		const exports = typeChecker.getExportsOfModule(module);
		exports.forEach((exportSymbol) => {
			const declaration = exportSymbol.valueDeclaration || exportSymbol.declarations?.[0];
			if (!declaration) return;

			// Collect classes, interfaces, types, enums, variables (only if @public)
			if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)
				|| ts.isTypeAliasDeclaration(declaration) || ts.isEnumDeclaration(declaration)
				|| ts.isVariableDeclaration(declaration)) {
				const hasPublicTag = ts.getJSDocTags(declaration).some(tag => tag.tagName.text === 'public');
				if (hasPublicTag) {
					exportedTypes.add(exportSymbol.getName());
				}
			}

			// Follow reexports
			else if (exportSymbol.flags & ts.SymbolFlags.Alias) {
				const aliasedSymbol = typeChecker.getAliasedSymbol(exportSymbol);
				const aliasedDeclaration = aliasedSymbol.valueDeclaration || aliasedSymbol.declarations?.[0];
				if (aliasedDeclaration) {
					// Check if the aliased symbol has @public tag
					const hasPublicTag = ts.getJSDocTags(aliasedDeclaration).some(tag => tag.tagName.text === 'public');
					if (hasPublicTag) {
						exportedTypes.add(exportSymbol.getName());
					}

					// Also recursively collect from the source module
					const sourceFile = aliasedDeclaration.getSourceFile();
					const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
					if (moduleSymbol) {
						collectExportedTypes(moduleSymbol, visited);
					}
				}
			}
		});
	};

	// Get all exported symbols recursively
	const getAllExportedSymbols = (module: ts.Symbol, visited = new Set<ts.Symbol>()): ts.Symbol[] => {
		if (visited.has(module)) return [];
		visited.add(module);

		const exports = typeChecker.getExportsOfModule(module);
		const symbols: ts.Symbol[] = [];

		exports.forEach((exportSymbol) => {
			const declaration = exportSymbol.valueDeclaration || exportSymbol.declarations?.[0];
			if (!declaration) return;

			// If it's a reexport, follow it recursively
			if (exportSymbol.flags & ts.SymbolFlags.Alias) {
				const aliasedSymbol = typeChecker.getAliasedSymbol(exportSymbol);
				const aliasedDeclaration = aliasedSymbol.valueDeclaration || aliasedSymbol.declarations?.[0];
				if (aliasedDeclaration) {
					const sourceFile = aliasedDeclaration.getSourceFile();
					const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
					if (moduleSymbol) {
						symbols.push(...getAllExportedSymbols(moduleSymbol, visited));
					}
				}
			}
			// Otherwise, add any symbol with @public tag (we'll filter by type later)
			else {
				const hasPublicTag = ts.getJSDocTags(declaration).some(tag => tag.tagName.text === 'public');
				if (hasPublicTag) {
					symbols.push(exportSymbol);
				}
			}
		});

		return symbols;
	};

	// Collect all exported types from all source files
	const allModuleSymbols: ts.Symbol[] = [];
	sourceFiles.forEach((sourceFile) => {
		const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
		if (moduleSymbol) {
			allModuleSymbols.push(moduleSymbol);
			collectExportedTypes(moduleSymbol);
		}
	});

	// Helper to find all potential type references in a type string
	const findAllTypeReferences = (typeString: string): string[] => {
		// Match PascalCase identifiers that could be type names
		const matches = typeString.match(/\b[A-Z][a-zA-Z0-9_]*\b/g) || [];
		return [...new Set(matches)]; // Remove duplicates
	};

	// Helper to filter references to only exported types (excluding current type)
	const filterToExportedTypes = (references: string[], currentTypeName?: string): string[] => {
		return references.filter(ref => exportedTypes.has(ref) && ref !== currentTypeName);
	};

	// Helper to process {@link} tags in JSDoc comments
	const processLinkTags = (text: string, currentTypeName?: string): string => {
		// Replace {@link TypeName} with [TypeName](./TypeName.md) if TypeName is exported
		// or just TypeName if not exported
		// If TypeName is the current type, just use code formatting without link
		return text.replace(/\{@link\s+([^}]+)\}/g, (_, typeName) => {
			const cleanTypeName = typeName.trim();
			if (cleanTypeName === currentTypeName) {
				return `\`${cleanTypeName}\``;
			}
			if (exportedTypes.has(cleanTypeName)) {
				return `[\`${cleanTypeName}\`](./${cleanTypeName}.md)`;
			}
			return `\`${cleanTypeName}\``;
		});
	};

	// Helper to extract linked types from {@link} tags in text
	const extractLinkedTypes = (text: string): string[] => {
		if (!text) return [];
		const linkMatches = text.match(/\{@link\s+([^}]+)\}/g) || [];
		return linkMatches.map((match) => {
			const typeName = match.replace(/\{@link\s+([^}]+)\}/, '$1').trim();
			return typeName;
		});
	};

	// Helper to format references with proper "and" and period
	// Optionally filters out references that were already mentioned in @link tags
	const formatReferences = (references: string[], linkedTypes: string[] = []): string => {
		if (references.length === 0) return '';

		// Filter out references that were already linked in the description
		const filteredReferences = references.filter(ref => !linkedTypes.includes(ref));

		if (filteredReferences.length === 0) return '';

		const refLinks = filteredReferences.map(ref => `[\`${ref}\`](./${ref}.md)`);
		const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
		return `\n\nSee ${formatter.format(refLinks)}.`;
	};

	// Helper to format object types with proper indentation
	const formatObjectType = (typeText: string): string => {
		// Remove JSDoc comments but preserve original structure
		let lines = typeText.split('\n');
		const result: string[] = [];

		// First remove all JSDoc comments from the entire text
		const cleanText = typeText.replace(/\/\*\*[\s\S]*?\*\//g, '');
		lines = cleanText.split('\n');

		for (const line of lines) {
			// Skip empty lines
			if (line.trim() === '') continue;

			result.push(line);
		}

		return result.join('\n');
	};

	// Helper to get better type string representation
	const getTypeString = (type: ts.Type): string => {
		// Handle array types specially
		if (typeChecker.isArrayType(type)) {
			const elementType = typeChecker.getTypeArguments(type as ts.TypeReference)[0];
			if (elementType) {
				return `${getTypeString(elementType)}[]`;
			}
		}

		// Check if it's an array-like type by checking the symbol name
		const typeString = typeChecker.typeToString(type);
		if (typeString === 'Array' && type.symbol && type.symbol.getName() === 'Array') {
			// Try to get type arguments from the type reference
			if ((type as any).typeArguments && (type as any).typeArguments.length > 0) {
				const elementType = (type as any).typeArguments[0];
				return `${getTypeString(elementType)}[]`;
			}
			// If we can't determine the element type, try looking at the declaration
			if (type.symbol.declarations && type.symbol.declarations[0]) {
				const declaration = type.symbol.declarations[0];
				if (
					ts.isTypeReferenceNode(declaration)
					&& declaration.typeArguments
					&& declaration.typeArguments.length > 0
				) {
					return `${declaration.typeArguments[0]!.getText()}[]`;
				}
			}
		}

		return typeString;
	};

	// Helper to clean up optional parameter types
	const cleanOptionalType = (type: string, isOptional: boolean) => {
		let cleanedType = type;
		if (isOptional) {
			// Remove "| undefined" from union types for optional parameters
			cleanedType = cleanedType.replace(/\s*\|\s*undefined$/, '').replace(/^undefined\s*\|\s*/, '');
		}
		// Convert string literals from double quotes to single quotes
		cleanedType = cleanedType.replace(/"([^"]*)"/g, '\'$1\'');

		// Format long union types with line breaks if they exceed 80 characters
		// Only apply to top-level unions, not unions nested within intersections, object types, or generic types
		if (cleanedType.includes(' | ') && cleanedType.length > 80 && !cleanedType.includes('&') && !cleanedType.includes('{') && !cleanedType.includes('<')) {
			const unionMembers = cleanedType.split(' | ');
			cleanedType = '\n\t| ' + unionMembers.join('\n\t| ');
		}

		return cleanedType;
	};

	// Get all exported symbols from all modules
	const allSymbols: ts.Symbol[] = [];
	allModuleSymbols.forEach((moduleSymbol) => {
		allSymbols.push(...getAllExportedSymbols(moduleSymbol));
	});
	const indexEntries: Array<{ name: string; type: string; group: string; order: number }> = [];

	// Create a map to track the order of symbols based on their appearance in the entry file
	const symbolOrderMap = new Map<string, number>();
	let orderIndex = 0;

	// Walk through all source files to establish order based on declaration/export order
	const establishSymbolOrder = (node: ts.Node): void => {
		if (ts.isExportDeclaration(node)) {
			// Handle export declarations like "export { Foo } from './foo'"
			if (node.exportClause && ts.isNamedExports(node.exportClause)) {
				node.exportClause.elements.forEach((element) => {
					const exportName = (element.propertyName || element.name).getText();
					if (!symbolOrderMap.has(exportName)) {
						symbolOrderMap.set(exportName, orderIndex++);
					}
				});
			}
		} else if (ts.isVariableStatement(node)) {
			// Handle variable statements like "export const foo = ..."
			if (node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
				node.declarationList.declarations.forEach((declaration) => {
					const name = declaration.name.getText();
					if (name && !symbolOrderMap.has(name)) {
						symbolOrderMap.set(name, orderIndex++);
					}
				});
			}
		} else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node)) {
			// Handle direct declarations
			if (node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
				const name = (node as any).name?.getText();
				if (name && !symbolOrderMap.has(name)) {
					symbolOrderMap.set(name, orderIndex++);
				}
			}
		}

		ts.forEachChild(node, establishSymbolOrder);
	};

	// Establish symbol order from all source files
	sourceFiles.forEach((sourceFile) => {
		establishSymbolOrder(sourceFile);
	});

	// Phase 1: Collect class hierarchy information
	allSymbols.forEach((exportSymbol) => {
		const declaration = exportSymbol.valueDeclaration || exportSymbol.declarations?.[0];
		if (!declaration) return;

		const hasPublicTag = ts.getJSDocTags(declaration).some(tag => tag.tagName.text === 'public');
		if (!hasPublicTag) return;

		// Collect inheritance information for classes
		if (ts.isClassDeclaration(declaration) && declaration.heritageClauses) {
			const symbolName = declaration.name?.getText();
			if (!symbolName) return;

			const extendsClauseNode = declaration.heritageClauses.find(
				clause => clause.token === ts.SyntaxKind.ExtendsKeyword,
			);
			if (extendsClauseNode && extendsClauseNode.types[0]) {
				const superClassName = extendsClauseNode.types[0].expression.getText();
				if (!classHierarchy.has(superClassName)) {
					classHierarchy.set(superClassName, []);
				}
				classHierarchy.get(superClassName)!.push(symbolName);
			}
		}
	});

	// Collect class instances
	allSymbols.forEach((exportSymbol) => {
		const declaration = exportSymbol.valueDeclaration || exportSymbol.declarations?.[0];
		if (!declaration) return;

		const hasPublicTag = ts.getJSDocTags(declaration).some(tag => tag.tagName.text === 'public');
		if (!hasPublicTag) return;

		if (ts.isVariableDeclaration(declaration)) {
			const variableName = declaration.name.getText();
			let className: string | undefined;
			// Check explicit type annotation
			if (declaration.type && ts.isTypeReferenceNode(declaration.type)) {
				className = declaration.type.typeName.getText();
			}
			// Check initializer for constructor calls
			else if (declaration.initializer && ts.isNewExpression(declaration.initializer)) {
				className = declaration.initializer.expression.getText();
			}
			if (className && exportedTypes.has(className)) {
				if (!classInstances.has(className)) {
					classInstances.set(className, []);
				}
				classInstances.get(className)!.push(variableName);
			}
		}
	});

	// Data structures for "Used by" feature
	const usedByReferences = new Map<string, Set<{ user: string; context: string; type: 'constructor' | 'method' | 'property' | 'extends' | 'type_param' | 'type_alias' | 'variable' | 'function' }>>();
	const generatedDocs = new Map<string, string>();

	const addUsage = (
		used: string,
		user: string,
		context: string,
		type: 'constructor' | 'method' | 'property' | 'extends' | 'type_param' | 'type_alias' | 'variable' | 'function',
	) => {
		// No self-references
		if (used === user) return;

		if (!usedByReferences.has(used)) {
			usedByReferences.set(used, new Set());
		}
		const usageSet = usedByReferences.get(used)!;

		// Check for duplicates before adding
		for (const item of usageSet) {
			if (item.user === user && item.context === context && item.type === type) {
				return;
			}
		}
		usageSet.add({ user, context, type });
	};

	// Phase 2: Generate documentation for each symbol (and collect usage data)
	allSymbols.forEach((exportSymbol) => {
		const declaration = exportSymbol.valueDeclaration || exportSymbol.declarations?.[0];
		if (!declaration) return;

		// Check if it's a supported symbol type
		const nodeKind = ts.SyntaxKind[declaration.kind];
		const symbolName = (declaration as any).name?.getText() || exportSymbol.getName();

		// Only process symbols with @public tag
		const hasPublicTag = ts.getJSDocTags(declaration).some(tag => tag.tagName.text === 'public');
		if (!hasPublicTag) return;

		// Check for @group tag (handle re-exports by looking at the original declaration)
		let targetDeclaration = declaration;
		if (exportSymbol.flags & ts.SymbolFlags.Alias) {
			const aliasedSymbol = typeChecker.getAliasedSymbol(exportSymbol);
			const aliasedDeclaration = aliasedSymbol.valueDeclaration || aliasedSymbol.declarations?.[0];
			if (aliasedDeclaration) {
				targetDeclaration = aliasedDeclaration;
			}
		}

		const groupTag = ts.getJSDocTags(targetDeclaration).find(tag => tag.tagName.text === 'group');
		if (!groupTag || typeof groupTag.comment !== 'string') {
			throw new Error(`Symbol '${symbolName}' is missing @group JSDoc tag`);
		}
		const groupName = groupTag.comment.trim().replace(/\\(.)/g, '$1');

		// Validate that the group exists in the API config
		if (!Object.prototype.hasOwnProperty.call(groupConfig, groupName)) {
			throw new Error(`Symbol '${symbolName}' has @group '${groupName}' which is not defined in API config`);
		}

		// Check if it's a supported type
		if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isVariableDeclaration(declaration)) {
			// Supported types - continue processing
		} else {
			// Unsupported type - throw error with type info
			throw new Error(`Unsupported symbol type: ${nodeKind} for symbol '${symbolName}'`);
		}

		if (!declaration.name) return;

		// Handle variable declarations separately
		if (ts.isVariableDeclaration(declaration)) {
			const variableName = declaration.name.getText();

			// Get variable description from JSDoc
			const jsDocComment = ts.getJSDocCommentsAndTags(declaration)[0];
			let description = '';
			if (jsDocComment && ts.isJSDoc(jsDocComment)) {
				const commentText = jsDocComment.comment;
				if (typeof commentText === 'string') {
					description = processLinkTags(commentText.trim(), variableName);
				}
			}

			// Check if it's a function type
			const variableType = typeChecker.getTypeAtLocation(declaration);
			const isFunctionType = variableType.getCallSignatures().length > 0;

			// Add to index
			const order = symbolOrderMap.get(variableName);
			if (order === undefined) {
				throw new Error(`Symbol '${variableName}' not found in entry files export order`);
			}
			indexEntries.push({ name: variableName, type: isFunctionType ? 'Function' : 'Constant', group: groupName, order });

			if (isFunctionType) {
				// Handle function variables like methods
				const signature = variableType.getCallSignatures()[0];
				if (signature) {
					const parameters = signature.getParameters();
					const params = parameters.map((param) => {
						const paramDecl = param.valueDeclaration;
						if (paramDecl && ts.isParameter(paramDecl)) {
							const paramName = param.getName();
							const hasQuestionToken = paramDecl.questionToken !== undefined;
							const hasDefault = paramDecl.initializer !== undefined;
							const isRest = paramDecl.dotDotDotToken !== undefined;
							const rawParamType = paramDecl.type ? paramDecl.type.getText() : typeChecker.typeToString(typeChecker.getTypeOfSymbolAtLocation(param, paramDecl));
							const paramType = cleanOptionalType(rawParamType, hasQuestionToken);

							if (hasDefault) {
								const defaultValue = paramDecl.initializer.getText();
								return `\t${isRest ? '...' : ''}${paramName}: ${paramType} = ${defaultValue}`;
							} else {
								return `\t${isRest ? '...' : ''}${paramName}${hasQuestionToken ? '?' : ''}: ${paramType}`;
							}
						}
						return `\t${param.getName()}: unknown`;
					});

					const returnType = getTypeString(signature.getReturnType());
					const functionSig = params.length > 0
						? `${variableName}(\n${params.join(',\n')},\n): ${returnType};`
						: `${variableName}(): ${returnType};`;

					let markdown = `<script setup>\nimport { VPBadge } from 'vitepress/theme'\n</script>\n\n<VPBadge type="info" text="Function" />\n\n# ${variableName}\n\n\`\`\`ts\n${functionSig}\n\`\`\`${description ? `\n\n${description}` : ''}`;

					// Find referenced types in all parameters and return type
					const allTypeStrings = params.map(p => p.replace(/\t.*?:\s*/, '')).concat([returnType]);
					const allReferences = filterToExportedTypes([...new Set(allTypeStrings.flatMap(findAllTypeReferences))], variableName);
					markdown += formatReferences(allReferences);

					// In tandem: update usage map
					allReferences.forEach(ref => addUsage(ref, variableName, variableName, 'function'));

					generatedDocs.set(variableName, markdown);
				}
			} else {
				// Handle regular variables
				let markdown = `<script setup>\nimport { VPBadge } from 'vitepress/theme'\n</script>\n\n<VPBadge type="info" text="Constant" />\n\n# ${variableName}\n\n${description ? `${description}\n\n` : ''}`;
				const variableValue = declaration.initializer ? declaration.initializer.getText() : 'undefined';
				const variableDefinition = `const ${variableName} = ${variableValue};`;
				markdown += `\`\`\`ts\n${variableDefinition}\n\`\`\``;

				// Find referenced types in the variable value
				const references = filterToExportedTypes(findAllTypeReferences(variableValue), variableName);
				markdown += formatReferences(references);

				// In tandem: update usage map
				references.forEach(ref => addUsage(ref, variableName, variableName, 'variable'));

				generatedDocs.set(variableName, markdown);
			}

			return;
		}

		{
			const className = declaration.name.text;
			const isAbstract = ts.isClassDeclaration(declaration) && declaration.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AbstractKeyword);

			// Add to index
			const order = symbolOrderMap.get(className);
			if (order === undefined) {
				throw new Error(`Symbol '${className}' not found in entry files export order`);
			}
			if (isAbstract) {
				indexEntries.push({ name: className, type: 'Abstract class', group: groupName, order });
			} else if (ts.isClassDeclaration(declaration)) {
				indexEntries.push({ name: className, type: 'Class', group: groupName, order });
			} else if (ts.isTypeAliasDeclaration(declaration)) {
				indexEntries.push({ name: className, type: 'Type', group: groupName, order });
			} else if (ts.isInterfaceDeclaration(declaration)) {
				indexEntries.push({ name: className, type: 'Interface', group: groupName, order });
			}

			const properties: string[] = [];
			const events: string[] = [];
			const methods: string[] = [];
			const staticMethods: string[] = [];
			let constructor: string | null = null;
			let extendsClause = '';
			let typeParameters: string | null = null;

			// Get class description from JSDoc (or from superclass if none)
			let description = '';
			const jsDocComment = ts.getJSDocCommentsAndTags(declaration)[0];

			if (jsDocComment && ts.isJSDoc(jsDocComment)) {
				// First try to get the comment from the parsed JSDoc
				const commentText = jsDocComment.comment;
				if (typeof commentText === 'string' && commentText.trim()) {
					description = processLinkTags(commentText.trim(), className);
				} else {
					// If no comment text, extract from raw source text
					const sourceFile = declaration.getSourceFile();
					const sourceText = sourceFile.getFullText();
					const start = jsDocComment.getStart();
					const end = jsDocComment.getEnd();
					const rawJsDoc = sourceText.substring(start, end);

					// Extract the content between /** and */
					const match = rawJsDoc.match(/\/\*\*(.*?)\*\//s);
					if (match && match[1]) {
						const content = match[1]
							.split('\n')
							.map(line => line.replace(/^\s*\*\s?/, '')) // Remove leading * and spaces
							.join('\n')
							.trim();

						// Filter out @tags but keep the description
						const lines = content.split('\n');
						const descLines = lines.filter(line => !line.trim().startsWith('@'));
						const rawDesc = descLines.join('\n').trim();

						if (rawDesc) {
							description = processLinkTags(rawDesc, className);
						}
					}
				}
			}

			// If no description, check superclass (only for classes/interfaces)
			if (!description && (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) && declaration.heritageClauses) {
				const classType = typeChecker.getTypeAtLocation(declaration);
				const baseTypes = classType.getBaseTypes();
				if (baseTypes && baseTypes.length > 0) {
					const baseSymbol = baseTypes[0]!.getSymbol();
					if (baseSymbol && baseSymbol.valueDeclaration) {
						const baseJsDoc = ts.getJSDocCommentsAndTags(baseSymbol.valueDeclaration)[0];
						if (baseJsDoc && ts.isJSDoc(baseJsDoc) && typeof baseJsDoc.comment === 'string') {
							description = processLinkTags(baseJsDoc.comment.trim(), className);
						}
					}
				}
			}

			// Check for type parameters (only for classes/interfaces)
			if ((ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) && declaration.typeParameters && declaration.typeParameters.length > 0) {
				const typeParamStrings = declaration.typeParameters.map((tp) => {
					const name = tp.name.text;
					const constraint = tp.constraint ? ` extends ${tp.constraint.getText()}` : '';
					const defaultType = tp.default ? ` = ${tp.default.getText()}` : '';
					return `\t${name}${constraint}${defaultType}`;
				});

				const typeParamSig = `${className}<\n${typeParamStrings.join(',\n')},\n>`;

				// Get type parameter descriptions
				const typeParamDocs: string[] = [];
				const classJsDoc = ts.getJSDocCommentsAndTags(declaration)[0];
				if (classJsDoc && ts.isJSDoc(classJsDoc)) {
					const templateTags = classJsDoc.tags?.filter((tag: any) => tag.tagName.text === 'template') || [];
					templateTags.forEach((tag: any) => {
						if (typeof tag.comment === 'string') {
							const parts = tag.comment.trim().split(/\s+/);
							const paramName = parts[0];
							const paramDesc = parts.slice(1).join(' ').replace(/^-\s*/, '');
							if (paramDesc) {
								typeParamDocs.push(`- **${paramName}**: ${paramDesc}`);
							}
						}
					});
				}

				typeParameters = `## Type parameters\n\n\`\`\`ts\n${typeParamSig}\n\`\`\``;
				if (typeParamDocs.length > 0) {
					typeParameters += `\n\n${typeParamDocs.join('\n')}`;
				}

				// Find referenced types in type parameters for classes/interfaces
				const typeParamRefs: string[] = [];
				declaration.typeParameters.forEach((tp) => {
					if (tp.constraint) {
						typeParamRefs.push(...findAllTypeReferences(tp.constraint.getText()));
					}
					if (tp.default) {
						typeParamRefs.push(...findAllTypeReferences(tp.default.getText()));
					}
				});
				const typeParamReferences = filterToExportedTypes([...new Set(typeParamRefs)], className);
				const typeParamReferencesText = formatReferences(typeParamReferences);
				if (typeParamReferencesText) {
					typeParameters += typeParamReferencesText;
				}

				// In tandem: update usage map
				typeParamReferences.forEach(ref => addUsage(ref, className, className, 'type_param'));
			}

			// Check for extends clause (only for classes/interfaces)
			if ((ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) && declaration.heritageClauses) {
				const extendsClauseNode = declaration.heritageClauses.find(
					clause => clause.token === ts.SyntaxKind.ExtendsKeyword,
				);
				if (extendsClauseNode && extendsClauseNode.types[0]) {
					const superClassName = extendsClauseNode.types[0].expression.getText();
					extendsClause = `\n\n**Extends:** [\`${superClassName}\`](./${superClassName}.md)\n`;

					// In tandem: update usage map
					if (exportedTypes.has(superClassName)) {
						addUsage(superClassName, className, className, 'extends');
					}
				}
			}

			// Helper to get JSDoc description with superclass fallback (recursive)
			const getDescriptionWithFallback = (member: ts.ClassElement | ts.TypeElement, memberName: string): string => {
				const jsDoc = ts.getJSDocCommentsAndTags(member)[0];
				if (jsDoc && ts.isJSDoc(jsDoc)) {
					// First try the parsed comment
					if (typeof jsDoc.comment === 'string' && jsDoc.comment.trim()) {
						return processLinkTags(jsDoc.comment.trim(), className);
					} else {
						// If no parsed comment, extract from raw source (same logic as class descriptions)
						const sourceFile = member.getSourceFile();
						const sourceText = sourceFile.getFullText();
						const start = jsDoc.getStart();
						const end = jsDoc.getEnd();
						const rawJsDoc = sourceText.substring(start, end);

						const match = rawJsDoc.match(/\/\*\*(.*?)\*\//s);
						if (match && match[1]) {
							const content = match[1]
								.split('\n')
								.map(line => line.replace(/^\s*\*\s?/, '')) // Remove leading * and spaces
								.join('\n')
								.trim();

							// Filter out @tags but keep the description
							const lines = content.split('\n');
							const descLines = lines.filter(line => !line.trim().startsWith('@'));
							const rawDesc = descLines.join('\n').trim();

							if (rawDesc) {
								return processLinkTags(rawDesc, className);
							}
						}
					}
				}

				// Recursively check superclass hierarchy for this member's documentation
				const findInHierarchy = (currentDeclaration: ts.ClassDeclaration): string => {
					const currentType = typeChecker.getTypeAtLocation(currentDeclaration);
					const baseTypes = currentType.getBaseTypes();

					if (baseTypes && baseTypes.length > 0) {
						const baseSymbol = baseTypes[0]!.getSymbol();
						if (baseSymbol && baseSymbol.valueDeclaration && ts.isClassDeclaration(baseSymbol.valueDeclaration)) {
							const baseMember = baseSymbol.valueDeclaration.members.find(m =>
								m.name && m.name.getText() === memberName,
							);
							if (baseMember) {
								const baseJsDoc = ts.getJSDocCommentsAndTags(baseMember)[0];
								if (baseJsDoc && ts.isJSDoc(baseJsDoc) && typeof baseJsDoc.comment === 'string') {
									return processLinkTags(baseJsDoc.comment.trim(), className);
								}
							}
							// Recursively check further up the hierarchy
							return findInHierarchy(baseSymbol.valueDeclaration);
						}
					}
					return '';
				};

				if (ts.isClassDeclaration(declaration)) {
					return findInHierarchy(declaration);
				}

				return '';
			};

			// Helper to extract linked types from a member's JSDoc
			const getLinkedTypesFromMember = (member: ts.ClassElement | ts.TypeElement): string[] => {
				const jsDoc = ts.getJSDocCommentsAndTags(member)[0];
				if (jsDoc && ts.isJSDoc(jsDoc)) {
					// First try the parsed comment
					if (typeof jsDoc.comment === 'string' && jsDoc.comment.trim()) {
						return extractLinkedTypes(jsDoc.comment.trim());
					} else {
						// If no parsed comment, extract from raw source
						const sourceFile = member.getSourceFile();
						const sourceText = sourceFile.getFullText();
						const start = jsDoc.getStart();
						const end = jsDoc.getEnd();
						const rawJsDoc = sourceText.substring(start, end);

						const match = rawJsDoc.match(/\/\*\*(.*?)\*\//s);
						if (match && match[1]) {
							const content = match[1]
								.split('\n')
								.map(line => line.replace(/^\s*\*\s?/, '')) // Remove leading * and spaces
								.join('\n')
								.trim();

							// Filter out @tags but keep the description
							const lines = content.split('\n');
							const descLines = lines.filter(line => !line.trim().startsWith('@'));
							const rawDesc = descLines.join('\n').trim();

							return extractLinkedTypes(rawDesc);
						}
					}
				}
				return [];
			};

			// Helper to process members (both own and inherited)
			const processMember = (member: ts.ClassElement | ts.TypeElement, _isInherited = false) => {
				// Check if member has @internal in JSDoc
				const hasInternalTag = ts.getJSDocTags(member).some(tag => tag.tagName.text === 'internal');
				if (hasInternalTag) return;

				if (ts.isConstructorDeclaration(member) && !isAbstract) {
					// Skip private constructors
					const isPrivate = member.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword);
					if (isPrivate) return;

					// Only process the first constructor we encounter to build the constructor section
					// We'll collect all overloads separately
					if (!constructor) {
						// Collect all constructor overloads from the class
						const constructorOverloads: ts.ConstructorDeclaration[] = [];
						if (ts.isClassDeclaration(declaration)) {
							declaration.members.forEach((m) => {
								if (ts.isConstructorDeclaration(m) && !m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword)) {
									constructorOverloads.push(m);
								}
							});
						}

						// Build individual constructor blocks with their own descriptions
						const constructorBlocks: string[] = [];
						const allReferencedTypes: string[] = [];

						// First, process constructor parameters with visibility modifiers as properties from any constructor
						// that has them (typically the implementation or the main signature)
						let processedProperties = false;
						constructorOverloads.forEach((ctor) => {
							// Process constructor parameters with visibility modifiers as properties (only once)
							if (!processedProperties) {
								const hasVisibilityParams = ctor.parameters.some(param =>
									param.modifiers?.some(mod =>
										mod.kind === ts.SyntaxKind.PublicKeyword
										|| mod.kind === ts.SyntaxKind.PrivateKeyword
										|| mod.kind === ts.SyntaxKind.ProtectedKeyword
										|| mod.kind === ts.SyntaxKind.ReadonlyKeyword,
									),
								);

								if (hasVisibilityParams) {
									ctor.parameters.forEach((param) => {
										// Check if parameter has visibility modifier (public, private, protected, readonly)
										const hasVisibilityModifier = param.modifiers?.some(mod =>
											mod.kind === ts.SyntaxKind.PublicKeyword
											|| mod.kind === ts.SyntaxKind.PrivateKeyword
											|| mod.kind === ts.SyntaxKind.ProtectedKeyword
											|| mod.kind === ts.SyntaxKind.ReadonlyKeyword,
										);

										if (!hasVisibilityModifier) return;

										// Skip private parameters
										const isPrivate = param.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword);
										if (isPrivate) return;

										const paramName = param.name.getText();
										const hasQuestionToken = param.questionToken !== undefined;
										const isReadonly = param.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ReadonlyKeyword);
										const rawParamType = param.type ? param.type.getText() : typeChecker.typeToString(typeChecker.getTypeAtLocation(param));
										const paramType = cleanOptionalType(rawParamType, hasQuestionToken);

										const propertyDef = `${isReadonly ? 'readonly ' : ''}${paramName}${hasQuestionToken ? '?' : ''}: ${paramType};`;

										// Get description from JSDoc comment on the parameter
										const paramJsDoc = ts.getJSDocCommentsAndTags(param)[0];
										let desc = '';
										if (paramJsDoc && ts.isJSDoc(paramJsDoc) && typeof paramJsDoc.comment === 'string') {
											desc = processLinkTags(paramJsDoc.comment.trim(), className);
										}

										// Find referenced types
										const references = filterToExportedTypes(findAllTypeReferences(paramType), className);
										const referencesText = formatReferences(references);

										// In tandem: update usage map
										references.forEach(ref => addUsage(ref, className, paramName, 'property'));

										const propertyContent = `### \`${paramName}\`\n\n\`\`\`ts\n${propertyDef}\n\`\`\`${desc ? `\n\n${desc}` : ''}${referencesText}`;
										properties.push(propertyContent);
									});
									processedProperties = true;
								}
							}
						});

						constructorOverloads.forEach((ctor) => {
							// Skip the implementation (the one with a body) unless it's the only constructor
							if (ctor.body && constructorOverloads.length > 1) {
								return;
							}

							// Build parameter list for this overload
							const params = ctor.parameters.map((param) => {
								const paramName = param.name.getText();
								const hasQuestionToken = param.questionToken !== undefined;
								const hasDefault = param.initializer !== undefined;
								const isRest = param.dotDotDotToken !== undefined;
								const rawParamType = param.type ? param.type.getText() : typeChecker.typeToString(typeChecker.getTypeAtLocation(param));
								const paramType = cleanOptionalType(rawParamType, hasQuestionToken);

								if (hasDefault) {
									const defaultValue = param.initializer.getText();
									return `\t${isRest ? '...' : ''}${paramName}: ${paramType} = ${defaultValue}`;
								} else {
									return `\t${isRest ? '...' : ''}${paramName}${hasQuestionToken ? '?' : ''}: ${paramType}`;
								}
							});

							const constructorSig = params.length > 0
								? `constructor(\n${params.join(',\n')},\n): ${className};`
								: `constructor(): ${className};`;

							// Collect referenced types from this overload
							const ctorTypeStrings = params.map(p => p.replace(/\t.*?:\s*/, ''));
							allReferencedTypes.push(...ctorTypeStrings.flatMap(findAllTypeReferences));

							// Get description for this specific overload
							const constructorDesc = getDescriptionWithFallback(ctor, 'constructor');
							const linkedTypes = getLinkedTypesFromMember(ctor);

							// Get parameter descriptions for this specific overload
							const paramDocs: string[] = [];
							const jsDoc = ts.getJSDocCommentsAndTags(ctor)[0];
							if (jsDoc && ts.isJSDoc(jsDoc)) {
								const paramTags = jsDoc.tags?.filter((tag: any) => tag.tagName.text === 'param') || [];
								paramTags.forEach((tag: any) => {
									if (ts.isJSDocParameterTag(tag) && tag.name && typeof tag.comment === 'string') {
										const paramName = tag.name.getText();
										const paramDesc = tag.comment.trim().replace(/^-\s*/, '');
										paramDocs.push(`- **${paramName}**: ${paramDesc}`);
									}
								});
							}

							// Build this constructor block
							let constructorBlock = `\`\`\`ts\n${constructorSig}\n\`\`\``;
							if (constructorDesc) {
								constructorBlock += `\n\n${constructorDesc}`;
							}
							if (paramDocs.length > 0) {
								constructorBlock += `\n\n**Parameters:**\n\n${paramDocs.join('\n')}`;
							}

							// Find referenced types for this overload
							const overloadReferences = filterToExportedTypes([...new Set(ctorTypeStrings.flatMap(findAllTypeReferences))], className);
							constructorBlock += formatReferences(overloadReferences, linkedTypes);

							// In tandem: update usage map
							overloadReferences.forEach(ref => addUsage(ref, className, className, 'constructor'));

							constructorBlocks.push(constructorBlock);
						});

						// Build the constructor section
						const headingText = constructorBlocks.length > 1 ? 'Constructors' : 'Constructor';
						const separator = constructorBlocks.length > 1 ? '\n\n---\n\n' : '\n\n';
						constructor = `## ${headingText}\n\n${constructorBlocks.join(separator)}`;
					}
				} else if ((ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) && member.name) {
					const name = member.name.getText();
					const isReadonly = member.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ReadonlyKeyword);
					const isOptional = member.questionToken !== undefined;
					// Prefer explicit type annotation if available, otherwise use type checker
					let rawType: string;
					if (member.type) {
						rawType = member.type.getText();
						// For optional properties, check if the type is a reference to an exported type
						// If so, don't apply undefined removal logic to preserve the type reference
						if (isOptional && exportedTypes.has(rawType)) {
							// Keep the original type reference for exported types
						} else {
							rawType = cleanOptionalType(rawType, isOptional);
						}
					} else {
						const memberType = typeChecker.getTypeAtLocation(member);
						const typeName = memberType.getSymbol()?.getName();
						// If the type has a symbol name and it's in our exported types, use that instead of expanding
						if (typeName && exportedTypes.has(typeName)) {
							rawType = typeName;
						} else {
							rawType = getTypeString(memberType);
							rawType = cleanOptionalType(rawType, isOptional);
						}
					}
					const type = rawType;
					const propertyDef = `${isReadonly ? 'readonly ' : ''}${name}${isOptional ? '?' : ''}: ${type};`;

					// Get description from JSDoc
					const desc = getDescriptionWithFallback(member, name);
					const linkedTypes = getLinkedTypesFromMember(member);

					// Find referenced types
					const references = filterToExportedTypes(findAllTypeReferences(type), className);
					const referencesText = formatReferences(references, linkedTypes);

					// In tandem: update usage map
					references.forEach(ref => addUsage(ref, className, name, 'property'));

					// Check if this is an event handler (starts with "on" and can be a function)
					const isEventHandler = name.startsWith('on') && (
						type.includes('=>')
						|| type.includes('Function')
						|| type.includes('() =>')
						|| (type.includes('(') && type.includes(') =>'))
					);

					const inheritedBadge = '';
					const propertyContent = `### \`${name}\`${inheritedBadge}\n\n\`\`\`ts\n${propertyDef}\n\`\`\`${desc ? `\n\n${desc}` : ''}${referencesText}`;

					if (isEventHandler) {
						events.push(propertyContent);
					} else {
						properties.push(propertyContent);
					}
				} else if (ts.isGetAccessorDeclaration(member) && member.name) {
					const name = member.name.getText();
					// For getters, prefer the explicit return type annotation if available
					let rawType: string;
					if (member.type) {
						rawType = member.type.getText();
					} else {
						const memberType = typeChecker.getTypeAtLocation(member);
						const typeName = memberType.getSymbol()?.getName();
						// If the type has a symbol name and it's in our exported types, use that instead of expanding
						if (typeName && exportedTypes.has(typeName)) {
							rawType = typeName;
						} else {
							rawType = getTypeString(memberType);
						}
					}
					const type = cleanOptionalType(rawType, false);
					const accessorDef = `get ${name}(): ${type};`;

					// Get description from JSDoc
					const desc = getDescriptionWithFallback(member, name);
					const linkedTypes = getLinkedTypesFromMember(member);

					// Find referenced types
					const references = filterToExportedTypes(findAllTypeReferences(type), className);
					const referencesText = formatReferences(references, linkedTypes);

					// In tandem: update usage map
					references.forEach(ref => addUsage(ref, className, name, 'property'));

					const inheritedBadge = '';
					properties.push(`### \`${name}\`${inheritedBadge}\n\n\`\`\`ts\n${accessorDef}\n\`\`\`${desc ? `\n\n${desc}` : ''}${referencesText}`);
				} else if (ts.isSetAccessorDeclaration(member) && member.name) {
					const name = member.name.getText();
					const param = member.parameters[0];
					const isOptional = param?.questionToken !== undefined;
					const rawParamType = param?.type
						? typeChecker.typeToString(typeChecker.getTypeAtLocation(param))
						: 'any';
					const paramType = cleanOptionalType(rawParamType, isOptional);
					const accessorDef = `set ${name}(value: ${paramType});`;

					// Get description from JSDoc
					const desc = getDescriptionWithFallback(member, name);
					const linkedTypes = getLinkedTypesFromMember(member);

					// Find referenced types
					const references = filterToExportedTypes(findAllTypeReferences(paramType), className);
					const referencesText = formatReferences(references, linkedTypes);

					// In tandem: update usage map
					references.forEach(ref => addUsage(ref, className, name, 'property'));

					const inheritedBadge = '';
					properties.push(`### \`${name}\`${inheritedBadge}\n\n\`\`\`ts\n${accessorDef}\n\`\`\`${desc ? `\n\n${desc}` : ''}${referencesText}`);
				} else if ((ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) && member.name) {
					const name = member.name.getText();
					const isStatic = member.modifiers?.some(mod => mod.kind === ts.SyntaxKind.StaticKeyword);

					// For method overloads, skip the implementation if it has no JSDoc
					// (the overload signatures should have the documentation)
					const methodJsDoc = ts.getJSDocCommentsAndTags(member)[0];
					const hasJsDoc = methodJsDoc && ts.isJSDoc(methodJsDoc) && methodJsDoc.comment;

					// If this is a method declaration (has a body) and has no JSDoc, check if there are overloads
					if (ts.isMethodDeclaration(member) && member.body && !hasJsDoc && ts.isClassDeclaration(declaration)) {
						// Check if there are other methods with the same name (overloads)
						const sameNameMethods = declaration.members.filter(m =>
							(ts.isMethodDeclaration(m) || ts.isMethodSignature(m))
							&& m.name && m.name.getText() === name,
						);

						// If there are multiple methods with the same name, this is likely an overloaded method
						// Skip the implementation (the one with a body) if it has no JSDoc
						if (sameNameMethods.length > 1) {
							return;
						}
					}

					// Build parameter list with each on its own line
					const params = member.parameters.map((param) => {
						const paramName = param.name.getText();
						const hasQuestionToken = param.questionToken !== undefined;
						const hasDefault = param.initializer !== undefined;
						const isRest = param.dotDotDotToken !== undefined;
						const rawParamType = param.type ? param.type.getText() : typeChecker.typeToString(typeChecker.getTypeAtLocation(param));
						const paramType = cleanOptionalType(rawParamType, hasQuestionToken);

						if (hasDefault) {
							const defaultValue = param.initializer.getText();
							return `\t${isRest ? '...' : ''}${paramName}: ${paramType} = ${defaultValue}`;
						} else {
							return `\t${isRest ? '...' : ''}${paramName}${hasQuestionToken ? '?' : ''}: ${paramType}`;
						}
					});

					// Get return type
					const signature = typeChecker.getSignatureFromDeclaration(member);
					const returnType = signature ? getTypeString(signature.getReturnType()) : 'void';

					// Format method signature
					const methodSig = params.length > 0
						? `${isStatic ? 'static ' : ''}${name}(\n${params.join(',\n')},\n): ${returnType};`
						: `${isStatic ? 'static ' : ''}${name}(): ${returnType};`;

					// Get method description from JSDoc
					const desc = getDescriptionWithFallback(member, name);
					const linkedTypes = getLinkedTypesFromMember(member);

					// Get parameter and return descriptions
					const paramDocs: string[] = [];
					let returnDoc = '';
					const jsDoc = ts.getJSDocCommentsAndTags(member)[0];
					if (jsDoc && ts.isJSDoc(jsDoc)) {
						const paramTags = jsDoc.tags?.filter((tag: any) => tag.tagName.text === 'param') || [];
						paramTags.forEach((tag: any) => {
							if (ts.isJSDocParameterTag(tag) && tag.name && typeof tag.comment === 'string') {
								const paramName = tag.name.getText();
								const paramDesc = tag.comment.trim().replace(/^-\s*/, '');
								paramDocs.push(`- **${paramName}**: ${paramDesc}`);
							}
						});

						const returnTags = jsDoc.tags?.filter((tag: any) => tag.tagName.text === 'returns' || tag.tagName.text === 'return') || [];
						if (returnTags.length > 0 && returnTags[0] && typeof returnTags[0].comment === 'string') {
							returnDoc = returnTags[0].comment.trim().replace(/^-\s*/, '');
						}
					}

					const inheritedBadge = '';
					let methodContent = `### \`${name}()\`${inheritedBadge}\n\n\`\`\`ts\n${methodSig}\n\`\`\``;
					if (desc) {
						methodContent += `\n\n${desc}`;
					}
					if (paramDocs.length > 0) {
						methodContent += `\n\n**Parameters:**\n\n${paramDocs.join('\n')}`;
					}
					if (returnDoc) {
						methodContent += `\n\n**Returns:** ${returnDoc}`;
					}

					// Find referenced types in all parameters and return type
					const allTypeStrings = params.map(p => p.replace(/\t.*?:\s*/, '')).concat([returnType]);
					const allReferences = filterToExportedTypes([...new Set(allTypeStrings.flatMap(findAllTypeReferences))], className);
					methodContent += formatReferences(allReferences, linkedTypes);

					// In tandem: update usage map
					allReferences.forEach(ref => addUsage(ref, className, name, 'method'));

					if (isStatic) {
						staticMethods.push(methodContent);
					} else {
						methods.push(methodContent);
					}
				}
			};

			// Track names of own members to avoid duplicates with inherited
			const ownMemberNames = new Set<string>();

			// Process own members first
			if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
				declaration.members.forEach((member) => {
					if (member.name) {
						ownMemberNames.add(member.name.getText());
					}
					processMember(member);
				});
			} else if (ts.isTypeAliasDeclaration(declaration)) {
				// For type aliases, check if it's a simple union type (like string literals)
				const resolvedType = typeChecker.getTypeAtLocation(declaration);

				// If it's a primitive type or simple union, skip property processing
				const isPrimitive = !!(resolvedType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral));
				const isSimpleUnion = resolvedType.isUnion() && resolvedType.types.every(t =>
					t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean),
				);

				if (!isPrimitive && !isSimpleUnion) {
					const typeProperties = typeChecker.getPropertiesOfType(resolvedType);

					typeProperties.forEach((prop) => {
					// Create a synthetic property signature for each resolved property
						const propName = prop.getName();
						const propType = typeChecker.getTypeOfSymbolAtLocation(prop, declaration);
						const propTypeString = getTypeString(propType);
						const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;

						// Get JSDoc from the original declaration
						let desc = '';
						const propDeclaration = prop.valueDeclaration || prop.declarations?.[0];
						if (propDeclaration) {
							const jsDoc = ts.getJSDocCommentsAndTags(propDeclaration)[0];
							if (jsDoc && ts.isJSDoc(jsDoc) && typeof jsDoc.comment === 'string') {
								desc = processLinkTags(jsDoc.comment.trim(), className);
							}
						}

						// Check if this property's original type annotation references an exported type
						let cleanedType = propTypeString;
						if (propDeclaration && ts.isPropertySignature(propDeclaration) && propDeclaration.type) {
							const originalType = propDeclaration.type.getText();
							if (exportedTypes.has(originalType)) {
								cleanedType = originalType;
							} else {
								cleanedType = cleanOptionalType(propTypeString, isOptional);
							}
						} else {
							cleanedType = cleanOptionalType(propTypeString, isOptional);
						}

						const propertyDef = `${propName}${isOptional ? '?' : ''}: ${cleanedType};`;

						// Find referenced types
						const references = filterToExportedTypes(findAllTypeReferences(cleanedType), className);
						const referencesText = formatReferences(references);

						// In tandem: update usage map
						references.forEach(ref => addUsage(ref, className, propName, 'property'));

						// Check if this is an event handler (starts with "on" and can be a function)
						const isEventHandler = propName.startsWith('on') && (
							cleanedType.includes('=>')
							|| cleanedType.includes('Function')
							|| cleanedType.includes('() =>')
							|| (cleanedType.includes('(') && cleanedType.includes(') =>'))
						);

						// Type alias properties are never inherited
						const propertyContent = `### \`${propName}\`\n\n\`\`\`ts\n${propertyDef}\n\`\`\`${desc ? `\n\n${desc}` : ''}${referencesText}`;

						if (isEventHandler) {
							events.push(propertyContent);
						} else {
							properties.push(propertyContent);
						}
					});
				}
			}

			// Process inherited members (skip if overridden, only for classes)
			if (ts.isClassDeclaration(declaration)) {
				const classType = typeChecker.getTypeAtLocation(declaration);
				const baseTypes = classType.getBaseTypes();
				if (baseTypes && baseTypes.length > 0) {
					baseTypes.forEach((baseType) => {
						const baseSymbol = baseType.getSymbol();
						if (baseSymbol && baseSymbol.valueDeclaration && ts.isClassDeclaration(baseSymbol.valueDeclaration)) {
							baseSymbol.valueDeclaration.members.forEach((member) => {
								// Skip if this member is overridden in the derived class
								if (member.name && ownMemberNames.has(member.name.getText())) {
									return;
								}
								// Never process inherited constructors - always use the derived class constructor
								if (ts.isConstructorDeclaration(member)) {
									return;
								}
								processMember(member, true);
							});
						}
					});
				}
			}

			// Sort properties and methods alphabetically (but not for type aliases - keep source order)
			if (!ts.isTypeAliasDeclaration(declaration)) {
				properties.sort((a, b) => {
					const nameA = a.match(/### (.+)/)?.[1] || '';
					const nameB = b.match(/### (.+)/)?.[1] || '';
					return nameA.localeCompare(nameB);
				});
			}

			staticMethods.sort((a, b) => {
				const nameA = a.match(/### (.+)/)?.[1] || '';
				const nameB = b.match(/### (.+)/)?.[1] || '';
				return nameA.localeCompare(nameB);
			});

			let markdown = '';

			// Add VPBadge import and badge for all types
			markdown += `<script setup>\nimport { VPBadge } from 'vitepress/theme'\n</script>\n\n`;

			if (isAbstract) {
				markdown += `<VPBadge type="info" text="Abstract class" />\n\n`;
			} else if (ts.isClassDeclaration(declaration)) {
				markdown += `<VPBadge type="info" text="Class" />\n\n`;
			} else if (ts.isTypeAliasDeclaration(declaration)) {
				markdown += `<VPBadge type="info" text="Type" />\n\n`;
			} else if (ts.isInterfaceDeclaration(declaration)) {
				markdown += `<VPBadge type="info" text="Interface" />\n\n`;
			}

			markdown += `# ${className}\n\n${description ? `${description}\n` : ''}${extendsClause}`;

			// Add subclasses section for classes that have subclasses
			if (ts.isClassDeclaration(declaration) && classHierarchy.has(className)) {
				// Recursively build hierarchical list
				const buildHierarchicalList = (parentClass: string, depth = 0, visited = new Set<string>()): string => {
					if (visited.has(parentClass)) return ''; // Prevent infinite loops
					visited.add(parentClass);

					const directChildren = classHierarchy.get(parentClass) || [];
					if (directChildren.length === 0) return '';

					// Sort children by definition order
					const sortedChildren = [...directChildren].sort((a, b) => {
						const orderA = symbolOrderMap.get(a);
						const orderB = symbolOrderMap.get(b);
						if (orderA === undefined) throw new Error(`Symbol '${a}' not found in entry files export order`);
						if (orderB === undefined) throw new Error(`Symbol '${b}' not found in entry files export order`);
						return orderA - orderB;
					});

					let result = '';
					const indent = '  '.repeat(depth);

					for (const child of sortedChildren) {
						result += `${indent}- [\`${child}\`](./${child}.md)\n`;
						// Recursively add children of this child
						result += buildHierarchicalList(child, depth + 1, visited);
					}

					return result;
				};

				const hierarchicalList = buildHierarchicalList(className);
				if (hierarchicalList) {
					markdown += `\n## Subclasses\n\n${hierarchicalList}`;
				}
			}

			// Add instances section for classes that have instances
			if (ts.isClassDeclaration(declaration) && classInstances.has(className)) {
				const instances = classInstances.get(className)!;
				// Sort by definition order instead of alphabetically
				instances.sort((a, b) => {
					const orderA = symbolOrderMap.get(a);
					const orderB = symbolOrderMap.get(b);
					if (orderA === undefined) throw new Error(`Symbol '${a}' not found in entry files export order`);
					if (orderB === undefined) throw new Error(`Symbol '${b}' not found in entry files export order`);
					return orderA - orderB;
				});
				markdown += `\n## Instances\n\n`;
				instances.forEach((instance) => {
					markdown += `- [\`${instance}\`](./${instance}.md)\n`;
				});
			}

			// Add placeholder for "Used by" section for classes and interfaces
			if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
				markdown += '\n<!-- USED_BY_SECTION -->\n';
			}

			// Add type definition for type aliases
			if (ts.isTypeAliasDeclaration(declaration) && declaration.type) {
				const resolvedType = typeChecker.getTypeAtLocation(declaration);
				const isPrimitive = !!(resolvedType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral));
				const isSimpleUnion = resolvedType.isUnion() && resolvedType.types.every(t =>
					t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean),
				);

				// Build the type name with generic parameters if they exist
				let typeName = className;
				if (declaration.typeParameters && declaration.typeParameters.length > 0) {
					const typeParamStrings = declaration.typeParameters.map((tp) => {
						const name = tp.name.text;
						const constraint = tp.constraint ? ` extends ${tp.constraint.getText()}` : '';
						const defaultType = tp.default ? ` = ${tp.default.getText()}` : '';
						return `${name}${constraint}${defaultType}`;
					});
					typeName = `${className}<${typeParamStrings.join(', ')}>`;
				}

				let typeText;
				if (isPrimitive || isSimpleUnion) {
					// For primitive types or simple unions, use resolved type string
					const resolvedTypeString = typeChecker.typeToString(resolvedType);
					if (resolvedTypeString === className) {
						// If resolved type is just the alias name, use original text
						typeText = declaration.type.getText();
					} else {
						typeText = resolvedTypeString;
					}
					// Convert string literals from double quotes to single quotes
					typeText = typeText.replace(/"([^"]*)"/g, '\'$1\'');
					if (typeText.includes(' | ')) {
						const unionMembers = typeText.split(' | ');
						typeText = '\n\t| ' + unionMembers.join('\n\t| ');
					}
				} else {
					// For complex types, use the original text
					typeText = declaration.type.getText();
					// Format object types with proper line breaks
					if (typeText.includes('{')) {
						typeText = formatObjectType(typeText);
					}
				}
				const typeDefinition = `type ${typeName} = ${typeText};`;

				// Find referenced types in the type definition and generic parameters
				const allTypeRefs = findAllTypeReferences(typeText);
				// Also find references in type parameters (extends clauses and default types)
				if (declaration.typeParameters && declaration.typeParameters.length > 0) {
					declaration.typeParameters.forEach((tp) => {
						if (tp.constraint) {
							allTypeRefs.push(...findAllTypeReferences(tp.constraint.getText()));
						}
						if (tp.default) {
							allTypeRefs.push(...findAllTypeReferences(tp.default.getText()));
						}
					});
				}
				const typeReferences = filterToExportedTypes([...new Set(allTypeRefs)], className);
				const typeReferencesText = formatReferences(typeReferences);

				// In tandem: update usage map
				typeReferences.forEach(ref => addUsage(ref, className, className, 'type_alias'));

				markdown += `\n\`\`\`ts\n${typeDefinition}\n\`\`\`${typeReferencesText}`;

				// Add placeholder for "Used by" section for type aliases
				markdown += '\n<!-- USED_BY_SECTION -->\n';
			}

			if (typeParameters) {
				markdown += `\n${typeParameters}\n\n`;
			}

			if (constructor) {
				markdown += `\n${constructor}\n\n`;
			}

			if (staticMethods.length > 0) {
				markdown += `\n## Static methods\n\n${staticMethods.join('\n\n')}\n\n`;
			}

			if (properties.length > 0) {
				markdown += `\n## Properties\n\n${properties.join('\n\n')}\n\n`;
			}

			if (events.length > 0) {
				markdown += `\n## Events\n\n${events.join('\n\n')}\n\n`;
			}

			if (methods.length > 0) {
				markdown += `\n## Methods\n\n${methods.join('\n\n')}\n`;
			}

			generatedDocs.set(className, markdown);
		}
	});

	// Phase 3: Assemble final docs with "Used by" sections and write files
	generatedDocs.forEach((markdown, symbolName) => {
		const usages = usedByReferences.get(symbolName);
		let usedByMarkdown = '';

		if (usages && usages.size > 0) {
			const symbolSubclasses = classHierarchy.get(symbolName) || [];

			const usedByLines = [...usages]
				.filter((usage) => {
					// Filter out subclasses from "Used by" since they already appear in "Subclasses" section
					if (usage.type === 'extends' && symbolSubclasses.includes(usage.user)) {
						return false;
					}

					// Filter out top-level type references when there are more specific contexts available
					// This prevents redundancy where both "TypeName" and "TypeName.property" appear
					if (usage.type === 'type_alias' || usage.type === 'type_param') {
						// Check if there are more specific usages from the same user (property, method, constructor, etc.)
						const hasMoreSpecificUsage = [...usages].some(otherUsage =>
							otherUsage.user === usage.user
							&& otherUsage.type !== 'type_alias'
							&& otherUsage.type !== 'type_param'
							&& otherUsage.type !== 'extends',
						);
						if (hasMoreSpecificUsage) {
							return false;
						}
					}

					return true;
				})
				.map((usage) => {
					let displayText = '';
					let link = '';

					switch (usage.type) {
						case 'constructor':
							displayText = `new ${usage.user}()`;
							link = `./${usage.user}.md#constructor`;
							break;
						case 'method':
							displayText = `${usage.user}.${usage.context}()`;
							link = `./${usage.user}.md#${usage.context.toLowerCase()}`;
							break;
						case 'property':
						case 'variable':
							displayText = `${usage.user}.${usage.context}`;
							link = `./${usage.user}.md#${usage.context.toLowerCase()}`;
							break;
						case 'function':
							displayText = `${usage.user}()`;
							link = `./${usage.user}.md`;
							break;
						case 'extends':
						case 'type_param':
						case 'type_alias':
							displayText = usage.user;
							link = `./${usage.user}.md`;
							break;
					}
					return { text: `[\`${displayText}\`](${link})`, sortKey: displayText.toLowerCase() };
				});

			if (usedByLines.length > 0) {
				// Sort alphabetically by display text
				usedByLines.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
				const listItems = usedByLines.map(item => `- ${item.text}`).join('\n');
				usedByMarkdown = `\n## Used by\n\n${listItems}\n`;
			}
		}

		const finalMarkdown = markdown.replace('<!-- USED_BY_SECTION -->', usedByMarkdown);
		if (!dry) {
			const outputPath = path.join(outputDir, `${symbolName}.md`);
			fs.writeFileSync(outputPath, finalMarkdown);
			console.log(`Generated: ${outputPath}`);
		}
	});

	// Generate index.md with all exported symbols grouped by group
	const entriesByGroup = new Map<string, Array<{ name: string; type: string; order: number }>>();

	indexEntries.forEach((entry) => {
		if (!entriesByGroup.has(entry.group)) {
			entriesByGroup.set(entry.group, []);
		}
		entriesByGroup.get(entry.group)!.push({ name: entry.name, type: entry.type, order: entry.order });
	});

	// Sort groups according to API config order
	const configGroups = Object.keys(groupConfig);
	const sortedGroups = configGroups.filter(group => entriesByGroup.has(group));

	// Check for groups in entries that aren't in config
	const missingGroups = Array.from(entriesByGroup.keys()).filter(group => !configGroups.includes(group));
	if (missingGroups.length > 0) {
		throw new Error(`Groups found in code but not in API config: ${missingGroups.join(', ')}`);
	}

	let indexMarkdown = `# ${headingText}\n\n`;

	// Add intro text if provided
	if (introText) {
		indexMarkdown += `${introText}\n\n`;
	}

	sortedGroups.forEach((group) => {
		const entries = entriesByGroup.get(group)!;
		// Sort entries by definition order
		entries.sort((a, b) => a.order - b.order);

		indexMarkdown += `## ${group}\n\n`;
		const groupDescription = groupConfig[group];
		if (groupDescription) {
			indexMarkdown += `${groupDescription}\n\n`;
		}
		entries.forEach((entry) => {
			indexMarkdown += `- [${entry.name}](./${entry.name}.md)\n`;
		});
		indexMarkdown += '\n';
	});

	if (!dry) {
		const indexPath = path.join(outputDir, 'index.md');
		fs.writeFileSync(indexPath, indexMarkdown);
		console.log(`Generated: ${indexPath}`);
	}

	// Generate index.json with sidebar config structure
	const sidebarConfig = sortedGroups.map((group) => {
		const entries = entriesByGroup.get(group)!;
		// Sort entries by definition order
		entries.sort((a, b) => a.order - b.order);

		return {
			text: group,
			collapsed: true,
			items: entries.map(entry => ({
				text: entry.name,
				link: `/api/${entry.name}`,
			})),
		};
	});

	if (!dry) {
		const jsonPath = path.join(outputDir, 'index.json');
		fs.writeFileSync(jsonPath, JSON.stringify(sidebarConfig, null, 2));
		console.log(`Generated: ${jsonPath}`);
	}
};

const main = () => {
	const args = process.argv.slice(2);

	// Check for --dry flag
	const dryIndex = args.indexOf('--dry');
	const dry = dryIndex !== -1;

	// Remove --dry flag from args
	if (dry) {
		args.splice(dryIndex, 1);
	}

	if (args.length < 2) {
		console.error('Usage: npm run generate-docs [--dry] <entry-file1> [entry-file2 ...] <api-config-file>');
		console.error('  --dry: Check if docs are generatable without writing files');
		console.error('  entry-files: One or more TypeScript entry files');
		console.error('  api-config-file: JSON config file defining groups');
		process.exit(1);
	}

	// Last argument is the config file, everything else are entry files
	const apiConfigFile = args[args.length - 1]!;
	const entryFiles = args.slice(0, -1);

	generateDocs(entryFiles, apiConfigFile, dry);
};

main();
