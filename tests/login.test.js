import { describe, expect, it } from 'vitest';
import { safeDestination } from '../src/login.js';

describe('safeDestination', () => {
  it('keeps a relative page of this app, query string included', () => {
    expect(safeDestination('prospection.html')).toBe('prospection.html');
    expect(safeDestination('backlog.html?page=2')).toBe('backlog.html?page=2');
  });

  it('falls back to the landing page for anything off-site or unexpected', () => {
    expect(safeDestination(null)).toBe('index.html');
    expect(safeDestination('https://evil.example/phish.html')).toBe('index.html');
    expect(safeDestination('//evil.example')).toBe('index.html');
    expect(safeDestination('/etc/passwd')).toBe('index.html');
    expect(safeDestination('javascript:alert(1)')).toBe('index.html');
  });
});
