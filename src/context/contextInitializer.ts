// Context Initialization Service - Automatic setup and synchronization
// Handles initialization and config store subscription for app context
// Ensures context is always synchronized with configuration changes

import { useConfigStore } from '../stores/configStore';
import { 
  initializeAppContext, 
  updateAppContext, 
  InvalidConfigurationError,
  ContextUpdateError 
} from './appContext';
import type { ApiConfig } from './appContext';

// Track subscription state to prevent duplicate subscriptions
let isSubscribed = false;
let unsubscribe: (() => void) | null = null;

/**
 * Get current configuration from config store
 * Returns null if configuration is incomplete (needs at least agency_id)
 */
const getCurrentConfig = (): ApiConfig | null => {
  const state = useConfigStore.getState();
  
  // Only agency_id is required; apiKey is optional (schedule-only mode)
  if (!state.agency_id || typeof state.agency_id !== 'number' || state.agency_id <= 0) {
    return null;
  }
  
  return {
    apiKey: state.apiKey || '',
    agencyId: state.agency_id
  };
};

/**
 * Handle configuration changes from the config store
 * Updates app context when configuration changes
 */
const handleConfigChange = (state: ReturnType<typeof useConfigStore.getState>): void => {
  try {
    const config = getCurrentConfig();
    
    if (config) {
      // Update context with new configuration
      updateAppContext(config);
      
      // Update favorites store with current agency
      import('../stores/favoritesStore').then(({ useFavoritesStore }) => {
        useFavoritesStore.getState().setCurrentAgency(config.agencyId);
      });
    }
    // Note: We don't reset context when config becomes incomplete
    // This allows the app to continue working with the last valid config
    // until a new valid config is provided
  } catch (error) {
    // Log error but don't throw - we don't want config changes to crash the app
    console.error('Failed to update app context from config change:', error);
    
    // If it's a validation error, we might want to notify the user
    if (error instanceof InvalidConfigurationError) {
      console.warn('Invalid configuration detected:', error.message);
    }
  }
};

/**
 * Set up app context with automatic initialization and synchronization
 * Should be called once at application startup
 * 
 * This function:
 * 1. Initializes context with current config if available
 * 2. Sets up subscription to config store changes
 * 3. Handles config updates automatically
 */
export const setupAppContext = (): void => {
  try {
    // Prevent duplicate subscriptions
    if (isSubscribed) {
      console.warn('App context is already set up. Skipping duplicate setup.');
      return;
    }
    
    // Initialize with current configuration if available
    const currentConfig = getCurrentConfig();
    if (currentConfig) {
      initializeAppContext(currentConfig);
      
      // Initialize favorites store with current agency
      import('../stores/favoritesStore').then(({ useFavoritesStore }) => {
        useFavoritesStore.getState().setCurrentAgency(currentConfig.agencyId);
      });
    }
    
    // Subscribe to config store changes for automatic updates
    unsubscribe = useConfigStore.subscribe(handleConfigChange);
    isSubscribed = true;
    
    console.log('App context setup completed successfully');
  } catch (error) {
    console.error('Failed to setup app context:', error);
    
    // Clean up on failure
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    isSubscribed = false;
    
    // Re-throw to allow caller to handle the error
    if (error instanceof InvalidConfigurationError || error instanceof ContextUpdateError) {
      throw error;
    }
    throw new ContextUpdateError(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Clean up app context setup
 * Unsubscribes from config store changes
 * Should be called when the app is shutting down (mainly for testing)
 */
export const cleanupAppContext = (): void => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  isSubscribed = false;
  console.log('App context cleanup completed');
};

/**
 * Check if app context is set up and subscribed
 * Useful for debugging and testing
 */
export const isAppContextSetup = (): boolean => {
  return isSubscribed;
};

/**
 * Force refresh app context from current config store state
 * Useful for manual synchronization if needed
 */
export const refreshAppContext = (): void => {
  const currentState = useConfigStore.getState();
  handleConfigChange(currentState);
};