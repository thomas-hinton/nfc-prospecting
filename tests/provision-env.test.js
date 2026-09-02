import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The provisioning wizard captures values a human types — including passwords, which
 * routinely contain quotes and shell metacharacters — and writes them to .env. What it
 * writes must survive `set -a && . ./.env`, so these tests drive the real `write_env`
 * and `_existing` from scripts/provision.sh and assert the round trip, never touching
 * the developer's own .env.
 *
 * Only the library above the STAGES marker is sourced: the stages below it are
 * interactive.
 */
const LIBRARY = `
  set -euo pipefail
  lib="$(mktemp)"; trap 'rm -f "$lib"' EXIT
  sed '/^# STAGES: author this section\\./,$d' scripts/provision.sh > "$lib"
  export ENV_FILE="$(mktemp)"
  . "$lib"
`;

/** Writes VALUE with the wizard, then reads it back the way a human sources .env. */
function roundTrip(value) {
  return execFileSync(
    'bash',
    [
      '-c',
      `${LIBRARY}
       write_env DB_PASSWORD "$VALUE" >/dev/null
       bash -c 'set -a; . "$1"; set +a; printf "%s" "$DB_PASSWORD"' _ "$ENV_FILE"`,
    ],
    { env: { ...process.env, VALUE: value }, encoding: 'utf8' }
  );
}

/** What a re-run of the wizard offers as the current value. */
function offeredOnRerun(value) {
  return execFileSync(
    'bash',
    [
      '-c',
      `${LIBRARY}
       write_env DB_PASSWORD "$VALUE" >/dev/null
       _existing DB_PASSWORD`,
    ],
    { env: { ...process.env, VALUE: value }, encoding: 'utf8' }
  );
}

const awkward = {
  'a single quote': "hunter's-p4ss",
  'several single quotes': "'''",
  'a double quote': 'say "hello"',
  'a dollar sign': 'p4ss$HOME$(whoami)',
  'a backtick': 'p4ss`id`',
  'a backslash': 'p4ss\\end',
  'spaces': 'correct horse battery staple',
  'a hash and semicolon': 'p4ss#comment; echo pwned',
  'a mix of everything': `x'y"z $HOME \`id\` \\ #;`,
  'an ordinary key': 'sb_publishable_AbCd1234',
};

describe('write_env', () => {
  for (const [description, value] of Object.entries(awkward)) {
    it(`writes a value containing ${description} so sourcing .env returns it verbatim`, () => {
      expect(roundTrip(value)).toBe(value);
    });
  }

  it('offers the real value, not its quoted form, when the wizard is re-run', () => {
    expect(offeredOnRerun("hunter's-p4ss")).toBe("hunter's-p4ss");
  });

  it('replaces a key rather than appending a second entry', () => {
    const output = execFileSync(
      'bash',
      [
        '-c',
        `${LIBRARY}
         write_env DB_PASSWORD "first'value" >/dev/null
         write_env DB_PASSWORD "second'value" >/dev/null
         grep -c '^DB_PASSWORD=' "$ENV_FILE"
         bash -c 'set -a; . "$1"; set +a; printf "%s" "$DB_PASSWORD"' _ "$ENV_FILE"`,
      ],
      { encoding: 'utf8' }
    );
    expect(output).toBe("1\nsecond'value");
  });
});
