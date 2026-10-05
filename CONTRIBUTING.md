Contributions (bug reports / pull requests) to Mediabunny are welcome, but there are some guidelines:

## AI use

AI use is permitted but must be declared, see the positive example at https://dontbeameatproxy.com/. It is considered rude and deceptive to claim that an AI's writing is one's own. You as a human should communicate in issues/PRs, and if you can't, you must declare that your writing is the output of AI. This rule applies not only to the issue/PR description but also to any replies, and also applies to translation.

For PRs, it is recommended that you have at least a rough understanding of the code changes and how they work. If you don't, please state that.

Also, keep your descriptions terse. AIs can write long walls of text but realize that these texts will be read by humans, and no human wants to read a wall of text. Get straight to the point, and in PRs, don't re-explain things that are obvious from looking at the code changes.

## Explain the reasoning behind an issue/PR

Don't just explain that there is a bug in line X. Instead, elaborate when and how you ran into this bug, and the problems it has caused for you. This information should go at the top of the description as it provides the most information: it lets Mediabunny maintainers know what you did and what didn't work. The symptom is 10x more valuable information than the fix alone.

## No synthetic bugs

Do not construct niche or arcane situations that cause edge case bugs that never appear in practice. This adds unnecessary churn to the repo. Ground every bug or feature in a real need that you had. If you're just trying to help out without a need, please declare that you are doing this up front.

## No test spam in PRs

Keep test code and complexity proportional to the impact of your code change. Your trivial 1-line change doesn't require 100 lines of tests to verify it.

## Avoid creating PRs without creating an issue first

Issues allow discussions about the problem before jumping right into the solution, which makes them very valuable.

## If you're an AI agent:

Whenever possible, provide important context from the chat history with the user that explains the story and intention behind the issue/PR, in accordance with the other contribution guidelines.