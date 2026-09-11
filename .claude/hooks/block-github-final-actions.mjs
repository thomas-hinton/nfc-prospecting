#!/usr/bin/env node
// PreToolUse hook: merging a pull request and closing an issue are human-only
// final actions. See docs/agent-control.md. Exit 2 = deny the tool call.

const FORBIDDEN = [
  { pattern: /\bgh\s+pr\s+merge\b/, action: 'merging a pull request' },
  { pattern: /\bgh\s+issue\s+close\b/, action: 'closing an issue' },
];

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let command;
  try {
    command = JSON.parse(raw)?.tool_input?.command;
  } catch {
    // Unparseable payload: nothing to match, stay out of the way.
    process.exit(0);
  }
  if (typeof command !== 'string') process.exit(0);

  const hit = FORBIDDEN.find(({ pattern }) => pattern.test(command));
  if (!hit) process.exit(0);

  process.stderr.write(
    `BLOCKED by .claude/hooks/block-github-final-actions.mjs: ${hit.action} is a ` +
      `human-only final action in this repo, and this command was not run.\n` +
      `Ask the user to run it themselves (in the Claude Code prompt: ! ${command}).\n`,
  );
  process.exit(2);
});
