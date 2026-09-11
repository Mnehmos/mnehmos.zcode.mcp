/** Shared fixtures referenced by more than one suite. */
import { ChatArgs } from '../src/schema/tools.js';

/**
 * A chat `send` with NO session_id must be valid: omitting it is the create-and-send path, and
 * requiring it was the bug that forced an ordering the runtime does not support (A21).
 */
export const CHAT_SESSION_ID_OPTIONAL = ChatArgs.safeParse({ action: 'send', text: 'hello' });
