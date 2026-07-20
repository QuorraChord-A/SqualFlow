import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AGENT_META, AgentIcon, runtimeSdkLabel } from './agentMeta';

describe('agentMeta', () => {
  it('uses the product-facing runtime names', () => {
    expect(runtimeSdkLabel('claudecode')).toBe('ClaudeCode');
    expect(runtimeSdkLabel('codex')).toBe('Codex');
  });

  it('renders the matching SVG icon for each runtime', () => {
    const { container, rerender } = render(<AgentIcon sdk="claudecode" />);
    expect(container.querySelector('img')).toHaveAttribute('src', AGENT_META.claudecode.iconPath);

    rerender(<AgentIcon sdk="codex" />);
    expect(container.querySelector('img')).toHaveAttribute('src', AGENT_META.codex.iconPath);
  });

  it.each(['claudecode', 'codex'] as const)('ships a valid %s SVG asset', (sdk) => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../public${AGENT_META[sdk].iconPath}`),
      'utf8',
    );
    const document = new DOMParser().parseFromString(source, 'image/svg+xml');

    expect(source.trimStart().startsWith('<svg')).toBe(true);
    expect(document.querySelector('parsererror')).toBeNull();
  });
});
