import ts from 'typescript';
import * as fs from 'fs';

const checkDocblocks = (filePath: string) => {
	const program = ts.createProgram([filePath], {});
	const sourceFile = program.getSourceFile(filePath);
	const checker = program.getTypeChecker();

	if (!sourceFile) {
		throw new Error(`Could not find source file: ${filePath}`);
	}

	const missingDocblocks: { name: string; kind: string; line: number; reason: string }[] = [];

	const checkNode = (node: ts.Node) => {
		if (
			ts.isInterfaceDeclaration(node)
			|| ts.isClassDeclaration(node)
			|| ts.isConstructorDeclaration(node)
			|| ts.isMethodDeclaration(node)
			|| ts.isGetAccessorDeclaration(node)
			|| ts.isSetAccessorDeclaration(node)
			|| ts.isPropertyDeclaration(node)
			|| ts.isFunctionDeclaration(node)
			|| ts.isTypeAliasDeclaration(node)
			|| ts.isEnumDeclaration(node)
			|| ts.isPropertySignature(node)
			|| ts.isMethodSignature(node)
			|| ts.isVariableStatement(node)
			|| ts.isVariableDeclaration(node)
			|| (ts.isParameter(node) && ts.isPropertyDeclaration(node.parent))
		) {
			let symbol: ts.Symbol | undefined;

			try {
				if (ts.isVariableStatement(node)) {
					node.declarationList.declarations.forEach((declaration) => {
						const declSymbol = checker.getSymbolAtLocation(declaration.name);
						if (declSymbol) {
							const docStatus = checkDocumentationContent(declSymbol, declaration);
							if (docStatus.hasProblem) {
								const name = declaration.name.getText(sourceFile);
								const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
								missingDocblocks.push({
									name,
									kind: 'variable',
									line,
									reason: docStatus.reason,
								});
							}
						}
					});
					return;
				} else if ('name' in node && node.name) {
					symbol = checker.getSymbolAtLocation(node.name);
				}
			} catch {
				symbol = undefined;
			}

			let name = 'anonymous';
			const kind = ts.SyntaxKind[node.kind].replace(/Declaration|Statement/g, '').toLowerCase();

			if (ts.isConstructorDeclaration(node)) {
				// For constructors, use the parent class name
				const parent = node.parent;
				if (ts.isClassDeclaration(parent) && parent.name) {
					name = parent.name.text;
				}
			} else if ('name' in node && node.name) {
				if (ts.isIdentifier(node.name)) {
					name = node.name.text;
				} else if ('getText' in node.name) {
					name = node.name.getText(sourceFile);
				}
			}

			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

			if (!symbol) {
				const jsDocNodes = ts.getJSDocCommentsAndTags(node);
				if (jsDocNodes.length === 0) {
					missingDocblocks.push({
						name,
						kind,
						line,
						reason: 'No docblock found',
					});
				} else {
					const docStatus = checkJSDocContent(jsDocNodes);
					if (docStatus.hasProblem) {
						missingDocblocks.push({
							name,
							kind,
							line,
							reason: docStatus.reason,
						});
					}
				}
			} else {
				const docStatus = checkDocumentationContent(symbol, node);
				if (docStatus.hasProblem) {
					missingDocblocks.push({
						name,
						kind,
						line,
						reason: docStatus.reason,
					});
				}
			}
		}

		ts.forEachChild(node, checkNode);
	};

	const checkDocumentationContent = (symbol: ts.Symbol, node: ts.Node) => {
		const docComments = symbol.getDocumentationComment(checker);
		if (docComments.length === 0) {
			const jsDocNodes = ts.getJSDocCommentsAndTags(node);
			if (jsDocNodes.length === 0) {
				return { hasProblem: true, reason: 'No docblock found' };
			}
			return checkJSDocContent(jsDocNodes);
		}

		// Get the raw text of the comment
		const docText = docComments.map(comment => comment.text).join('').trim();

		// Remove all @tags with regex
		const cleanedText = docText.replace(/@\S+/g, '').trim();

		// If nothing remains after removing tags, it's just modifiers
		if (cleanedText.length === 0) {
			return { hasProblem: true, reason: 'Docblock contains only modifiers' };
		}

		return { hasProblem: false, reason: '' };
	};

	const checkJSDocContent = (jsDocNodes: readonly ts.Node[]) => {
		if (jsDocNodes.length === 0) {
			return { hasProblem: true, reason: 'No docblock found' };
		}

		for (const node of jsDocNodes) {
			if (ts.isJSDoc(node)) {
				let commentText = '';

				if (typeof node.comment === 'string') {
					commentText = node.comment;
				} else if (Array.isArray(node.comment)) {
					// Handle JSDoc comment parts (including @link tags)
					commentText = node.comment
						.map((part) => {
							if (typeof part === 'string') {
								return part;
							} else if (part && typeof part === 'object' && 'text' in part) {
								return part.text || '';
							}
							return '';
						})
						.join('');
				}

				// Remove all @tags with regex
				const cleanedText = commentText.replace(/@\S+/g, '').trim();

				// If there's content after removing tags, it's a meaningful docblock
				if (cleanedText.length > 0) {
					return { hasProblem: false, reason: '' };
				}
			}
		}

		return { hasProblem: true, reason: 'Docblock contains only modifiers' };
	};

	if (sourceFile) {
		checkNode(sourceFile);
	}

	return {
		success: missingDocblocks.length === 0,
		missingDocblocks,
	};
};

const main = () => {
	const args = process.argv.slice(2);

	if (args.length !== 1) {
		console.error('Missing file argument.');
		process.exit(1);
	}

	const filePath = args[0]!;

	if (!fs.existsSync(filePath)) {
		console.error(`File not found: ${filePath}`);
		process.exit(1);
	}

	try {
		const result = checkDocblocks(filePath);

		if (result.success) {
			console.log(`✅ All symbols in ${filePath} have meaningful docblocks.`);
		} else {
			console.log(
				`❌ Found ${result.missingDocblocks.length} symbols with insufficient docblocks:`,
			);

			result.missingDocblocks.forEach((item) => {
				console.log(`  - ${item.kind} '${item.name}' at ${filePath}:${item.line}: ${item.reason}`);
			});

			process.exit(1);
		}
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
};

main();
