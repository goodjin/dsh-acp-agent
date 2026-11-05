export { DEFAULT_WORKBUDDY_BASE, WORKBUDDY_AUTH_PREFIX, WORKBUDDY_BASE_ENV, WORKBUDDY_PLATFORM, resolveEndpoints } from './endpoints.ts'
export type { WorkBuddyEndpoints } from './endpoints.ts'
export { buildChatBody, resolveReasoningEffort } from './openai.ts'
export type { ChatBodyInput, WorkBuddyBody, WorkBuddyContentPart, WorkBuddyMessage, WorkBuddyTool, WorkBuddyToolCall } from './openai.ts'
export { chunksFromOpenAiEvents, readSseEvents } from './sse.ts'
export type { WorkBuddyBlock, WorkBuddyFinish, WorkBuddyStreamChunk, WorkBuddyUsage } from './sse.ts'
export { scrub, streamWorkBuddy, TRANSPORT_FAILURE_CODE } from './chat.ts'
export type { WorkBuddyChatRequest } from './chat.ts'
export { fetchAccount, LOGIN_PENDING_CODE, pollForToken, refreshSession, startLogin } from './auth.ts'
export type { WorkBuddyAccount, WorkBuddyCredential, WorkBuddyLoginStart } from './auth.ts'
export {
  attachAccount,
  clearStoredCredential,
  credentialFilePath,
  credentialResolver,
  forceRefreshCredential,
  readStoredCredential,
  WorkBuddyAuthRequiredError,
  writeStoredCredential,
} from './credential.ts'
export type { CredentialStoreOptions } from './credential.ts'
export { clearSelection, readSelection, selectionFilePath, writeSelection } from './selection.ts'
export { fetchModels, loadCatalog, parseModels, readDesktopCatalog } from './models.ts'
export type { WorkBuddyCatalog, WorkBuddyCatalogSource, WorkBuddyModel } from './models.ts'
