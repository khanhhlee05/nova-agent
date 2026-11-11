import { ACCOUNT_LIMITS } from "@nova-agent/protocol";
import type { NovaDb } from "../../storage/novaDb";
import { getPreference, listConversations, putSyncedConversation, setPreference } from "../../storage/repositories";
import type { AccountClient } from "./account";
import { reviveMessages, type StoredConversation } from "./conversations";

/**
 * Keeping saved conversations on the Nova server the student is signed in
 * to, so they follow the student to another device. It is a separate
 * choice from saving on this device, off by default, because a conversation
 * holds course titles and dates and this is the one place they are stored
 * anywhere but here.
 *
 * The rule between two copies is that the newer one wins, whole. A deletion
 * is remembered until the server confirms it, so a conversation deleted
 * while the server was out of reach does not come back.
 */

/** Preference key for conversations deleted here that the server has not yet been told about. */
export const SYNC_DELETED_PREFERENCE = "ask.sync.deleted";

const MAX_TOMBSTONES = 100;

const tombstones = async (db: NovaDb): Promise<string[]> => {
  const stored = await getPreference<unknown>(db, SYNC_DELETED_PREFERENCE, []);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
};

const bodyOf = (conversation: StoredConversation) => ({ title: conversation.title.slice(0, ACCOUNT_LIMITS.conversationTitle), createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messages: conversation.messages });

/** Copies one saved conversation to the server. True when the server stored it. */
export const pushConversation = (account: AccountClient, conversation: StoredConversation): Promise<boolean> => account.putConversation(conversation.id, bodyOf(conversation));

/** Deletes one conversation on the server, remembering the deletion until the server confirms it. */
export const removeRemoteConversation = async (account: AccountClient, db: NovaDb, id: string): Promise<void> => {
  const pending = await tombstones(db);
  if (!pending.includes(id)) await setPreference(db, SYNC_DELETED_PREFERENCE, [...pending, id].slice(-MAX_TOMBSTONES));
  if (await account.deleteConversation(id)) await setPreference(db, SYNC_DELETED_PREFERENCE, (await tombstones(db)).filter((entry) => entry !== id));
};

/** Preference key set while the server still has to be told to delete every copy. */
export const SYNC_PURGE_PREFERENCE = "ask.sync.purge";

/**
 * Deletes every copy on the server. Used when the student turns the server
 * copy, or saving itself, off. If the server cannot be reached the request
 * is remembered and made again by `retryPurge`, so "off" ends with nothing
 * left there.
 */
export const removeAllRemoteConversations = async (account: AccountClient, db: NovaDb): Promise<boolean> => {
  await setPreference(db, SYNC_PURGE_PREFERENCE, true);
  const confirmed = await account.deleteConversations();
  if (confirmed) {
    await setPreference(db, SYNC_PURGE_PREFERENCE, false);
    await setPreference(db, SYNC_DELETED_PREFERENCE, []);
  }
  return confirmed;
};

/** Finishes a deletion of every server copy that could not be confirmed earlier. True when nothing is left to do. */
export const retryPurge = async (account: AccountClient, db: NovaDb): Promise<boolean> => ((await getPreference<boolean>(db, SYNC_PURGE_PREFERENCE, false)) === true ? removeAllRemoteConversations(account, db) : true);

export type SyncResult = { pulled: number; pushed: number; deleted: number };

/**
 * Brings this device and the server to the same set of conversations:
 * pending deletions first, then whatever is newer on the server comes here,
 * then whatever is newer here goes there. Null when the server could not be
 * asked (not signed in, or out of reach); nothing is changed then.
 */
export const syncConversations = async (account: AccountClient, db: NovaDb, scope: string): Promise<SyncResult | null> => {
  const result: SyncResult = { pulled: 0, pushed: 0, deleted: 0 };
  for (const id of await tombstones(db)) {
    if (!(await account.deleteConversation(id))) continue;
    result.deleted += 1;
    await setPreference(db, SYNC_DELETED_PREFERENCE, (await tombstones(db)).filter((entry) => entry !== id));
  }
  const remote = await account.listConversations();
  if (remote === null) return null;
  const deleted = new Set(await tombstones(db));
  const local = new Map((await listConversations(db, scope)).map((conversation) => [conversation.id, conversation]));
  const remoteById = new Map(remote.map((summary) => [summary.id, summary]));

  for (const summary of remote) {
    if (deleted.has(summary.id)) continue;
    const mine = local.get(summary.id);
    if (mine && mine.updatedAt >= summary.updatedAt) continue;
    const full = await account.getConversation(summary.id);
    if (!full) continue;
    // What comes back is checked like anything read from storage: a shape this build does not know loses that part, never the panel.
    const messages = reviveMessages(full.messages);
    if (messages.length === 0) continue;
    await putSyncedConversation(db, scope, { id: full.id, title: full.title, createdAt: full.createdAt, updatedAt: full.updatedAt, messages });
    result.pulled += 1;
  }
  // Read again: the pull may have pushed older conversations out of the newest twenty.
  for (const conversation of await listConversations(db, scope)) {
    const theirs = remoteById.get(conversation.id);
    if (theirs && theirs.updatedAt >= conversation.updatedAt) continue;
    if (await pushConversation(account, conversation)) result.pushed += 1;
  }
  return result;
};
