// Global App Context - Module-level state management for configuration
// Eliminates manual config store imports and parameter passing
// Provides type-safe, centralized access to API configuration

// TypeScript interfaces
export interface ApiConfig {
  apiKey: string;
  agencyId: number; // Normalized from agency_id
}

export interface AppContextState {
  apiConfig: ApiConfig | null;
  isInitialized: boolean;
  lastUpdated: number;
}

// Custom error classes for comprehensive error handling
export class ContextNotInitializedError extends Error {
  constructor() {
    super('App context not initialized. Ensure setupAppContext() is called at startup.');
    this.name = 'ContextNotInitializedError';
  }
}

export class InvalidConfigurationError extends Error {
  constructor(reason: string) {
    super(`Invalid configuration: ${reason}`);
    this.name = 'InvalidConfigurationError';
  }
}

export class ContextUpdateError extends Error {
  constructor(reason: string) {
    super(`Failed to update context: ${reason}`);
    this.name = 'ContextUpdateError';
  }
}

// Module-level state - private to this module
let contextState: AppContextState = {
  apiConfig: null,
  isInitialized: false,
  lastUpdated: 0
};

/**
 * Initialize the app context with API configuration
 * Should be called once at application startup.
 * apiKey is optional — without it, only static data is available.
 */
export const initializeAppContext = (config: ApiConfig): void => {
  try {
    if (!config.agencyId || typeof config.agencyId !== 'number' || config.agencyId <= 0) {
      throw new InvalidConfigurationError('agencyId must be a positive number');
    }

    // apiKey is optional (schedule-only mode when absent)
    const apiKey = (config.apiKey && typeof config.apiKey === 'string' && config.apiKey.trim() !== '')
      ? config.apiKey.trim()
      : '';

    contextState = {
      apiConfig: {
        apiKey,
        agencyId: config.agencyId
      },
      isInitialized: true,
      lastUpdated: Date.now()
    };
  } catch (error) {
    contextState = {
      apiConfig: null,
      isInitialized: false,
      lastUpdated: 0
    };
    
    if (error instanceof InvalidConfigurationError) {
      throw error;
    }
    throw new ContextUpdateError(`Initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Update the app context with new API configuration
 * Handles configuration changes during runtime.
 * apiKey is optional.
 */
export const updateAppContext = (config: ApiConfig): void => {
  try {
    if (!config.agencyId || typeof config.agencyId !== 'number' || config.agencyId <= 0) {
      throw new InvalidConfigurationError('agencyId must be a positive number');
    }

    const apiKey = (config.apiKey && typeof config.apiKey === 'string' && config.apiKey.trim() !== '')
      ? config.apiKey.trim()
      : '';

    contextState.apiConfig = { apiKey, agencyId: config.agencyId };
    contextState.lastUpdated = Date.now();
    
    if (!contextState.isInitialized) {
      contextState.isInitialized = true;
    }
  } catch (error) {
    if (error instanceof InvalidConfigurationError) {
      throw error;
    }
    throw new ContextUpdateError(`Update failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Get API configuration from the app context
 * Throws descriptive errors if context is not ready
 */
export const getApiConfig = (): ApiConfig => {
  if (!contextState.isInitialized) {
    throw new ContextNotInitializedError();
  }
  
  if (!contextState.apiConfig) {
    throw new InvalidConfigurationError('API configuration is null despite initialization');
  }
  
  return {
    apiKey: contextState.apiConfig.apiKey,
    agencyId: contextState.apiConfig.agencyId
  };
};

/**
 * Check if the app context is ready for use
 * Non-throwing method for conditional logic
 */
export const isContextReady = (): boolean => {
  return contextState.isInitialized && contextState.apiConfig !== null;
};

/**
 * Get context state for debugging (read-only)
 * Should not be used in production code
 */
export const getContextState = (): Readonly<AppContextState> => {
  return {
    ...contextState,
    apiConfig: contextState.apiConfig ? { ...contextState.apiConfig } : null
  };
};

/**
 * Reset context state (for testing purposes)
 * Should not be used in production code
 */
export const resetContext = (): void => {
  contextState = {
    apiConfig: null,
    isInitialized: false,
    lastUpdated: 0
  };
};