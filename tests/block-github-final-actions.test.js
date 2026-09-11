import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(
  new URL('../.claude/hooks/block-github-final-actions.mjs', import.meta.url),
);

/** Drive the hook exactly as Claude Code does: the PreToolUse payload on stdin. */
function runHook(command) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

describe('block-github-final-actions hook', () => {
  describe('blocks human-only final actions', () => {
    it.each([
      'gh pr merge 12 --squash',
      'gh pr merge 12',
      'gh issue close 7',
      'gh issue close 7 --comment "done"',
    ])('blocks %s', (command) => {
      const { status, stderr } = runHook(command);
      expect(status).toBe(2);
      expect(stderr).toMatch(/BLOCKED/);
    });

    it('blocks a forbidden command chained after an allowed one', () => {
      expect(runHook('gh issue view 7 && gh issue close 7').status).toBe(2);
    });
  });

  describe('allows everything else', () => {
    it.each([
      'gh issue view 7',
      'gh issue comment 7 --body "handing off"',
      'gh issue list --state open',
      'gh issue edit 7 --remove-label "ready-for-agent" --add-label "ready-for-human"',
      'gh pr view 12',
      'gh pr create --title "x" --body "y"',
      'npm test',
      'git status',
    ])('allows %s', (command) => {
      expect(runHook(command).status).toBe(0);
    });
  });

  it('stays out of the way when the payload has no command', () => {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a.js' } }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});
