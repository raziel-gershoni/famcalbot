/**
 * Voice module barrel re-export
 * Maintains backward compatibility for imports from voice-input-handler
 */

// Main entry point
export { handleVoiceMessage, handleEditIntent, handleDeleteIntent } from './handler';

// Callback handlers
export { handleEventCallback, handleEditCallback, handleDeleteCallback } from './callbacks';

// Event resolution (used externally by webhook-handlers)
export { trackCreatedEvent, getLastCreatedEvent, findMatchingEvent } from './event-resolution';

// Confirmations (used externally)
export { showEditConfirmation, showDeleteConfirmation } from './confirmations';
