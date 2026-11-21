import type { Express } from 'express';

import type { A2uiImportFailure, A2uiImportRequest, A2uiImportResult } from '@open-design/contracts';

import { importA2ui, loadA2uiDesignSystem } from '../a2ui/import.js';

export interface RegisterA2uiRoutesDeps {
  /** Built-in design systems (read-only resource tree). */
  designSystemsRoot: string;
  /** User-installed design systems (`user:<id>`), derived from the daemon data root. */
  userDesignSystemsRoot: string;
}

/**
 * POST /api/a2ui/import — A2UI 1.0 message stream in, design-system-styled
 * HTML out. Pure transformation: nothing is persisted and nothing is
 * fetched. 200 carries an `A2uiImportSuccess`; 422 carries an
 * `A2uiImportFailure` with typed error codes; 400 is a malformed request.
 */
export function registerA2uiRoutes(app: Express, deps: RegisterA2uiRoutesDeps): void {
  app.post('/api/a2ui/import', async (req, res) => {
    try {
      const { stream, designSystemId } = (req.body ?? {}) as Partial<A2uiImportRequest>;
      if (typeof designSystemId !== 'string' || designSystemId.length === 0) {
        return res.status(400).json({ error: 'designSystemId required' });
      }
      if (typeof stream !== 'string' && !Array.isArray(stream)) {
        return res.status(400).json({ error: 'stream required (JSON/JSONL text or an array of messages)' });
      }
      const isUser = designSystemId.startsWith('user:');
      const loaded = await loadA2uiDesignSystem(
        isUser ? deps.userDesignSystemsRoot : deps.designSystemsRoot,
        isUser ? designSystemId.slice('user:'.length) : designSystemId,
        designSystemId,
      );
      if (!loaded.ok) {
        const failure: A2uiImportFailure = {
          ok: false, a2uiVersion: '1.0', designSystemId, errors: [loaded.error], warnings: [],
        };
        return res.status(422).json(failure);
      }
      const result: A2uiImportResult = importA2ui(stream, loaded.designSystem);
      return res.status(result.ok ? 200 : 422).json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });
}
