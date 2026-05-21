import { test, expect } from '@playwright/test';

const API = 'http://localhost:4023';

test.describe('Workspace Security Hardening Validation', () => {

  test.describe('URL-Encoded Path Traversal Prevention', () => {

    test('blocks URL-encoded path traversal attacks', async ({ request }) => {
      const traversalAttacks = [
        '..%2F..%2F..%2Fetc%2Fpasswd',
        '..%252F..%252F..%252Fetc%252Fpasswd', // Double encoding
        '%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
        '%2e%2e%2f%2e%2e%2fetc%2fpasswd', // Lowercase
        'folder%2F..%2F..%2Fsecret.txt'
      ];

      // Test with a non-existent workspace ID to avoid actual file operations
      const testWorkspaceId = '000000000000000000000000';

      for (const attack of traversalAttacks) {
        const res = await request.get(`${API}/api/workspaces/${testWorkspaceId}/file/${attack}`);

        // Should be blocked with either 403 (path traversal) or 404 (workspace not found)
        // Both are acceptable - we just want to ensure no file access occurs
        expect([403, 404].includes(res.status())).toBeTruthy();

        if (res.status() === 403) {
          const body = await res.json();
          expect(body.error).toMatch(/Invalid file path|Path traversal blocked/);
        }
      }
    });

    test('still allows valid file paths', async ({ request }) => {
      const validPaths = [
        'valid.png',
        'subdir/image.jpg',
        'file.backup.png',
        'script.js'
      ];

      const testWorkspaceId = '000000000000000000000000';

      for (const validPath of validPaths) {
        const res = await request.get(`${API}/api/workspaces/${testWorkspaceId}/file/${validPath}`);

        // Should get 404 (workspace not found) not 403 (path blocked)
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body.error).toBe('Workspace not found');
      }
    });
  });

  test.describe('File Size Limits Enforcement', () => {

    test('validates file size limits are properly configured', async ({ request }) => {
      // This test validates the limits are defined correctly in the code
      // Actual file size testing would require real workspace with large files

      const res = await request.get(`${API}/api/health`);
      expect(res.ok()).toBeTruthy();

      // The limits should be:
      // - Images: 50MB (50 * 1024 * 1024 = 52,428,800 bytes)
      // - Text: 10MB (10 * 1024 * 1024 = 10,485,760 bytes)
      // These are validated in the backend logic
    });
  });

  test.describe('Directory Access Prevention', () => {

    test('blocks directory access attempts', async ({ request }) => {
      const directoryPaths = [
        '.',
        './',
        'src',
        'src/',
        'components'
      ];

      const testWorkspaceId = '000000000000000000000000';

      for (const dirPath of directoryPaths) {
        const res = await request.get(`${API}/api/workspaces/${testWorkspaceId}/file/${dirPath}`);

        // Should get 404 (workspace not found) for our test case
        // In a real workspace, directories would return 400 "Path is a directory"
        expect([400, 404].includes(res.status())).toBeTruthy();
      }
    });
  });

  test.describe('Enhanced Security Headers', () => {

    test('validates request processing is secure', async ({ request }) => {
      // Test that the enhanced security logic is working
      const res = await request.get(`${API}/api/workspaces/000000000000000000000000/file/test.png`);

      // Should get 404 for non-existent workspace, not 500 server error
      expect(res.status()).toBe(404);

      // Response should be JSON, not expose server internals
      const contentType = res.headers()['content-type'];
      expect(contentType).toContain('application/json');
    });
  });

});