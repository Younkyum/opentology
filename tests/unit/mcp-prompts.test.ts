import { describe, it, expect } from 'vitest';
import { generateSlashCommands } from '../../src/templates/slash-commands.js';

describe('MCP prompts from slash commands', () => {
  const commands = generateSlashCommands();

  it('generates at least one slash command', () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  it('each command has filename and content', () => {
    for (const cmd of commands) {
      expect(cmd.filename).toBeTruthy();
      expect(cmd.content).toBeTruthy();
    }
  });

  it('filenames end with .md', () => {
    for (const cmd of commands) {
      expect(cmd.filename).toMatch(/\.md$/);
    }
  });

  it('prompt names are valid after stripping .md', () => {
    for (const cmd of commands) {
      const name = cmd.filename.replace(/\.md$/, '');
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('generates expected prompt names', () => {
    const names = commands.map((c) => c.filename.replace(/\.md$/, ''));
    expect(names).toContain('context-init');
    expect(names).toContain('context-load');
    expect(names).toContain('context-save');
    expect(names).toContain('context-status');
  });
});
