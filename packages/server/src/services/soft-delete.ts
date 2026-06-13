/**
 * Soft Delete Helpers
 *
 * Shared interface and utilities for soft-deleting org resources (agents,
 * workflows, teams, skills). Deleted records remain in MongoDB but are
 * hidden everywhere by applying `notDeletedFilter` to list/detail queries.
 *
 * Recovery v1 is restore-by-create: creating a resource with the same name
 * as a soft-deleted record restores it instead of inserting a new row.
 */

// ── Interface ──

export interface SoftDeleteFields {
  isDeleted?: boolean;
  deletedAt?: Date | null;
  deletedBy?: string | null;
  deletedReason?: string | null;
  restoredAt?: Date | null;
}

// ── Constants ──

/** Reusable MongoDB filter that excludes soft-deleted records. */
export const notDeletedFilter = { isDeleted: { $ne: true } };

// ── Helpers ──

/**
 * Build a `$set` document for soft-deleting a record.
 * Optionally records who performed the delete.
 */
export function softDeleteSet(currentUserId?: string | null): Record<string, unknown> {
  const setFields: Record<string, unknown> = {
    isDeleted: true,
    deletedAt: new Date(),
    updatedAt: new Date(),
  };
  if (currentUserId) {
    setFields.deletedBy = currentUserId;
  }
  return { $set: setFields };
}

/**
 * Build a `$set` + `$unset` document for restoring a soft-deleted record.
 * The new payload (without soft-delete fields) is merged into `$set` along
 * with the restore timestamp. The old `deletedBy` and `deletedReason` are
 * unset so they don't persist in the restored document.
 */
export function restoreSet(newPayload: Record<string, unknown>): Record<string, unknown> {
  return {
    $set: {
      ...newPayload,
      isDeleted: false,
      deletedAt: null,
      restoredAt: new Date(),
      updatedAt: new Date(),
    },
    $unset: { deletedBy: '', deletedReason: '' },
  };
}
