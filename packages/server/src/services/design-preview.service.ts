/**
 * Design Preview Service
 *
 * Handles preview configuration validation and translation to workspace
 * service config for the Allen Desktop Design Tab. Validates preview
 * config fields per TDD §1.2 and translates them to workspace service
 * descriptors per REQ-025.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DesignPreviewConfig {
  enabled: boolean;
  workingDirectory: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  portMode: 'auto' | 'fixed';
  fixedPort?: number;
  healthCheckPath?: string;
  lastValidatedAt?: Date;
  lastValidationStatus?: 'unknown' | 'passed' | 'failed';
  lastValidationError?: string;
}

export interface ValidationResult {
  ok: boolean;
  code?: string;
  details?: { field: string; value: unknown };
}

// ── Service ────────────────────────────────────────────────────────────────

export class DesignPreviewService {
  constructor() {}

  /**
   * Validate a DesignPreviewConfig against the rules in TDD §1.2.
   * Returns { ok: true } on success, or { ok: false, code, details } on failure.
   */
  validateConfig(config: DesignPreviewConfig): ValidationResult {
    // Rule 1: startCommand non-empty when enabled === true
    if (config.enabled && !config.startCommand) {
      return {
        ok: false,
        code: 'DESIGN_PREVIEW_START_COMMAND_REQUIRED',
        details: { field: 'startCommand', value: config.startCommand },
      };
    }

    // Rule 2: workingDirectory must not start with '/'
    if (config.workingDirectory.startsWith('/')) {
      return {
        ok: false,
        code: 'DESIGN_PREVIEW_WORKDIR_ABSOLUTE',
        details: { field: 'workingDirectory', value: config.workingDirectory },
      };
    }

    // Rule 3: workingDirectory must not contain '..' segment
    const segments = config.workingDirectory.split('/');
    if (segments.some((s) => s === '..')) {
      return {
        ok: false,
        code: 'DESIGN_PREVIEW_WORKDIR_INVALID',
        details: { field: 'workingDirectory', value: config.workingDirectory },
      };
    }

    // Rule 4: fixedPort required when portMode === 'fixed', must be integer 1024-65535
    if (config.portMode === 'fixed') {
      if (
        config.fixedPort === undefined ||
        config.fixedPort === null ||
        !Number.isInteger(config.fixedPort) ||
        config.fixedPort < 1024 ||
        config.fixedPort > 65535
      ) {
        return {
          ok: false,
          code: 'DESIGN_PREVIEW_FIXED_PORT_REQUIRED',
          details: { field: 'fixedPort', value: config.fixedPort },
        };
      }
    }

    return { ok: true };
  }

  /**
   * Translate a DesignPreviewConfig to workspace service config per REQ-025.
   */
  toWorkspaceConfig(config: DesignPreviewConfig): {
    setupScript: string[];
    services: Array<{ name: string; command: string; portOffset: number; healthCheck?: string }>;
    autoStart: boolean;
  } {
    const setupScript = [config.installCommand, config.buildCommand].filter(
      (cmd): cmd is string => Boolean(cmd),
    );

    const resolvedCommand = `cd ${config.workingDirectory} && ${config.startCommand.replaceAll('{port}', '{port:0}')}`;

    return {
      setupScript,
      services: [
        {
          name: 'preview',
          command: resolvedCommand,
          portOffset: 0,
          healthCheck: config.healthCheckPath ?? '/',
        },
      ],
      autoStart: false,
    };
  }

  /**
   * Basic test of the config in a given worktree path.
   * Validates config first, then checks the workingDirectory exists in the worktree.
   *
   * TODO: AC-022 — full preview server start/health-check is out of scope for v1.
   * In v2 this should: spawn the install/build/start commands, wait for the
   * health check endpoint to respond, return the preview URL, and tear down on
   * timeout. For now we only validate config and check path existence.
   */
  async testConfig(
    config: DesignPreviewConfig,
    worktreePath: string,
  ): Promise<{ status: 'passed' | 'failed'; logs: string[]; previewUrl?: string }> {
    const logs: string[] = [];

    // Step 1: validate config
    const validation = this.validateConfig(config);
    if (!validation.ok) {
      logs.push(`Config validation failed: ${validation.code}`);
      return { status: 'failed', logs };
    }
    logs.push('Config validation: passed');

    // Step 2: check workingDirectory exists in the worktree
    const targetDir = join(worktreePath, config.workingDirectory);
    if (!existsSync(targetDir)) {
      logs.push(`Working directory not found: ${config.workingDirectory} (resolved: ${targetDir})`);
      return { status: 'failed', logs };
    }
    logs.push(`Working directory exists: ${config.workingDirectory}`);

    logs.push('Preview config test passed (path check only — full preview start deferred to v2)');
    return { status: 'passed', logs };
  }
}
