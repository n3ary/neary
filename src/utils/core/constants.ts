// Application Constants
// Centralized configuration for cache durations and other app-wide settings

/**
 * API Configuration
 * Centralized API endpoints and configuration
 */
export const API_CONFIG = {
  // Base URL for all Tranzy API endpoints
  BASE_URL: '/api/tranzy/v1/opendata',
} as const;

/**
 * Refresh and cache configuration constants (in milliseconds)
 * Single-tier caching: In-memory cache checks only
 */

// Auto-refresh cycle configuration
export const AUTO_REFRESH_CYCLE = 120 * 1000; // 2 minutes

// Prediction update cycle configuration (independent of API refresh)
export const PREDICTION_UPDATE_CYCLE = 15 * 1000; // 15 seconds

// API cache durations (when to fetch new data from API)
export const API_CACHE_DURATION = {
  // Vehicle data - cache duration 
  VEHICLES: 60 * 1000, // 1 minute
  
  // Static data - 24 hours (routes, stations, shapes, trips, stop times)
  STATIC_DATA: 24 * 60 * 60 * 1000, // 24 hours
  
  // Favorites data - 24 hours
  FAVORITES: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// API data staleness thresholds (for display purposes only)
export const API_DATA_STALENESS_THRESHOLDS = {
  // Vehicle data shows as stale after 5 minutes
  VEHICLES: 5 * 60 * 1000, // 5 minutes
  
  // Static data shows as stale after 24 hours
  STATIC_DATA: 24 * 60 * 60 * 1000, // 24 hours
} as const;

/**
 * GPS Data Age Indicator Configuration
 * Independent from cache freshness system - these control user-facing indicators
 * showing how old vehicle GPS timestamps are
 */
export const GPS_DATA_AGE_THRESHOLDS = {
  // GPS timestamp age threshold for "healthy" status (green indicator)
  HEALTHY: 3 * 60 * 1000, // 3 minutes
  
  // GPS timestamp age threshold for "stale" status (yellow indicator)
  STALE: 5 * 60 * 1000, // 5 minutes
  
  // Anything above STALE is "very stale" (red indicator)
} as const;

/**
 * API Fetch Freshness Thresholds (in milliseconds)
 * Controls refresh button color states based on API fetch time
 * Provides more granular UI feedback than staleness thresholds
 */
export const API_FETCH_FRESHNESS_THRESHOLDS = {
  // Green: API fetch age under 1 minute
  FRESH: 60 * 1000, // 1 minute
  
  // Yellow: API fetch age between 1-3 minutes
  WARNING: 180 * 1000, // 3 minutes
  
  // Red: API fetch age over 3 minutes (implicit, anything above WARNING)
} as const;

/**
 * Refresh Button Animation Durations (in milliseconds)
 * Different speeds for cache checks vs API calls
 */
export const REFRESH_ANIMATION_DURATIONS = {
  // Fast animation for cache checks
  CACHE_CHECK: 500, // 0.5 seconds per rotation
  
  // Normal animation for API calls (Material-UI default)
  API_CALL: 1400, // 1.4 seconds per rotation
} as const;

/**
 * Performance optimization constants
 */
export const PERFORMANCE = {
  // Minimum time between refresh calls to avoid spam
  MIN_REFRESH_INTERVAL: 1000,
  
  // Maximum number of concurrent API requests
  MAX_CONCURRENT_REQUESTS: 3,
} as const;

/**
 * Manual refresh debounce (ms).
 *
 * This is NOT a cache tier — it is the debounce window for the refresh BUTTON.
 * The auto-refresh cadence is independent (AUTO_REFRESH_CYCLE) and is never
 * changed by tapping. When the user taps refresh:
 *   - if the vehicle data is OLDER than this window  -> force a real fetch;
 *   - if it is YOUNGER (a fetch would just be skipped) -> recompute predictions
 *     instead, so the tap is still rewarding (no API call, quota-friendly).
 * Mirrors the vehicle data freshness so "inside the window" == "a fetch would be
 * a no-op".
 */
export const MANUAL_REFRESH_DEBOUNCE_MS = API_CACHE_DURATION.VEHICLES; // 60s

/**
 * Arrival time calculation constants
 * Configurable values for arrival time estimation (Requirements 2.3, 2.5)
 */
export const ARRIVAL_CONFIG = {
  // Average bus speed for time calculations (km/h)
  // Reduced from 25 to 18 for more realistic urban conditions
  AVERAGE_SPEED: 18,
  
  // Dwell time per intermediate stop (seconds)
  // Increased from 30 to 60 for more realistic stop times
  DWELL_TIME: 30,
  
  // Proximity threshold for "at stop" status (meters)
  PROXIMITY_THRESHOLD: 50,
  
  // Recent departure window for "just left" status (minutes)
  RECENT_DEPARTURE_WINDOW: 2,
  
  // Off-route threshold for distance from route shape (meters)
  OFF_ROUTE_THRESHOLD: 200
} as const;

/**
 * Ghost vehicle matching & frequency-based suppression (Req 7, 12).
 *
 * A "ghost" is a scheduled departure that has begun (its scheduled departure
 * passed) but has no live GPS vehicle. It is shown as a moving vehicle at a
 * schedule-interpolated position UNLESS a real GPS vehicle is effectively the
 * same run. Matching is positional: if a GPS vehicle on the same route is within
 * `matchDistance` of the ghost's predicted position, the ghost is suppressed.
 *
 * The match distance scales with the route's scheduled headway near "now":
 * low-frequency routes (long headway) tolerate a larger distance; high-frequency
 * routes tolerate less. On high-frequency routes (headway below
 * HIGH_FREQUENCY_HEADWAY_MINUTES) that already have ANY live GPS vehicle, ghosts
 * are not shown at all — the live feed is dense enough that synthesized runs add
 * only noise/duplicates.
 */
export const GHOST_VEHICLE_MATCH = {
  // Default positional match distance (meters) at the ~10-min headway pivot.
  BASE_DISTANCE_METERS: 500,
  // Clamp bounds for the frequency-scaled match distance (meters).
  MIN_DISTANCE_METERS: 250,
  MAX_DISTANCE_METERS: 1500,
  // Headway (minutes) at/below which a route is "high frequency".
  HIGH_FREQUENCY_HEADWAY_MINUTES: 10,
  // Window (minutes) around "now" used to estimate the route's headway.
  HEADWAY_WINDOW_MINUTES: 60,
  // A live GPS vehicle within this distance of a run's START stop, moving slower
  // than START_CLAIM_SPEED_KMH, is treated as the bus that will serve (or is
  // serving, late) a departure from that stop. It "claims" the nearest run by
  // scheduled time, suppressing that run's future/ghost card. This is what lets
  // a vehicle waiting at the start (before its time) or a LATE bus that just
  // pulled in cover its scheduled run even though the on-time interpolated
  // ghost position would be far away (so the positional rule alone would miss it).
  START_CLAIM_PROXIMITY_METERS: 150,
  START_CLAIM_SPEED_KMH: 5,
  // Reserved for the moving "late bus" reassignment: once a bus that was waiting
  // at the start leaves the stop BEFORE its claimed scheduled time, it is a late
  // earlier run and should cover that run's ghost. Bounds how late that can be.
  LATE_CLAIM_WINDOW_MINUTES: 45,
} as const;

/**
 * Location update configuration
 */
export const LOCATION_CONFIG = {
  // Minimum distance change to trigger station re-filtering (meters)
  REFILTER_DISTANCE_THRESHOLD: 500,
  
  // Default settings
  DEFAULT_ACCURACY: 'balanced' as const,
  CACHE_TIMEOUT: 300000, // 5 minutes
  DISTANCE_THRESHOLD: 1000, // 1km
  
  // Accuracy timeouts
  HIGH_ACCURACY_TIMEOUT: 15000,
  BALANCED_ACCURACY_TIMEOUT: 10000,
  LOW_ACCURACY_TIMEOUT: 5000,
  
  // Cache ages
  HIGH_ACCURACY_CACHE: 60000,    // 1 minute
  BALANCED_ACCURACY_CACHE: 300000, // 5 minutes
  LOW_ACCURACY_CACHE: 600000     // 10 minutes
} as const;

/**
 * Vehicle display optimization constants
 * Configuration for station vehicle list display logic (Requirements 1.4, 4.1)
 */
export const VEHICLE_DISPLAY = {
  // Maximum vehicles to show before applying grouping logic
  VEHICLE_DISPLAY_THRESHOLD: 5,
  
  // Maximum vehicles per trip status in grouped mode
  MAX_VEHICLES_PER_TRIP_STATUS: 1,
} as const;

/**
 * Confidence calculation thresholds
 * Distance and confidence values for arrival time calculations
 */
export const CONFIDENCE_THRESHOLDS = {
  HIGH_DISTANCE: 50,    // meters
  MEDIUM_DISTANCE: 100, // meters  
  LOW_DISTANCE: 200,    // meters
  HIGH_CONFIDENCE: 0.9,
  MEDIUM_CONFIDENCE: 0.7,
  LOW_CONFIDENCE: 0.5,
  FALLBACK_CONFIDENCE: 0.3
} as const;

/**
 * Calculation tolerances
 * Tolerance values for geometric and distance calculations
 */
export const CALCULATION_TOLERANCES = {
  SEGMENT_DISTANCE: 0.5, // 50% tolerance for segment distance validation
  COMPRESSION_RATIO_THRESHOLD: 1.1 // Minimum compression ratio to log
} as const;

/**
 * Time formatting thresholds
 * Thresholds for relative time display formatting
 */
export const TIME_THRESHOLDS = {
  JUST_NOW_SECONDS: 30,
  SECONDS_DISPLAY_MAX: 60,
  MINUTES_DISPLAY_MAX: 60,
  HOURS_DISPLAY_MAX: 24
} as const;

/**
 * Speed prediction configuration
 * Parameters for dynamic speed prediction system (Requirements 7.1, 7.2, 7.3, 7.4, 7.5)
 */
export const SPEED_PREDICTION_CONFIG = {
  // Speed validation
  SPEED_THRESHOLD: 5, // km/h - below this is considered stationary
  FALLBACK_SPEED: 25, // km/h - static fallback speed
  MIN_REASONABLE_SPEED: 1, // km/h - minimum valid speed
  MAX_REASONABLE_SPEED: 120, // km/h - maximum valid speed
  
  // Nearby vehicle analysis
  NEARBY_VEHICLE_RADIUS: 1000, // meters - radius for finding nearby vehicles
  MIN_NEARBY_VEHICLES: 2, // minimum for averaging
  MAX_NEARBY_VEHICLES: 50, // limit for performance
  
  // Location-based speed calculation
  MAX_DISTANCE_FROM_CENTER: 20000, // meters - beyond this, use fallback
  MIN_LOCATION_SPEED: 15, // km/h - minimum city center speed
  MAX_LOCATION_SPEED: 45, // km/h - maximum suburban speed
  
  // Legacy compatibility
  NEARBY_RADIUS: 1000, // meters (alias for NEARBY_VEHICLE_RADIUS)
  LOCATION_SPEED: {
    BASE_SPEED: 25, // km/h - suburban/highway speed
    DENSITY_FACTOR: 0.3, // how much city center affects speed
    MAX_DISTANCE: 20000, // meters - beyond this, use base speed
  },
  
  // Update frequencies
  DENSITY_CACHE_DURATION: 3600000, // ms - 1 hour cache for station density
  CALCULATION_TIMEOUT: 50, // ms - max time for speed calculation
} as const;

/**
 * Configuration validation utilities
 * Validation functions for speed prediction parameters (Requirements 7.4, 7.5)
 */
export class SpeedPredictionConfigValidator {
  /**
   * Validates speed threshold parameter
   * @param threshold Speed threshold in km/h
   * @returns true if valid, false otherwise
   */
  static validateSpeedThreshold(threshold: number): boolean {
    return threshold > 0 && threshold < 100; // reasonable range for transit vehicles
  }
  
  /**
   * Validates nearby vehicle radius parameter
   * @param radius Radius in meters
   * @returns true if valid, false otherwise
   */
  static validateRadius(radius: number): boolean {
    return radius > 0 && radius <= 5000; // max 5km radius for performance
  }
  
  /**
   * Validates location-based speed parameters
   * @param baseSpeed Base speed in km/h
   * @param densityFactor Density factor (0-1)
   * @returns true if valid, false otherwise
   */
  static validateLocationSpeedParams(baseSpeed: number, densityFactor: number): boolean {
    return baseSpeed > 0 && baseSpeed < 200 && densityFactor >= 0 && densityFactor <= 1;
  }
  
  /**
   * Validates performance limit parameters
   * @param maxVehicles Maximum nearby vehicles to process
   * @param timeoutMs Calculation timeout in milliseconds
   * @returns true if valid, false otherwise
   */
  static validatePerformanceLimits(maxVehicles: number, timeoutMs: number): boolean {
    return maxVehicles > 0 && maxVehicles <= 100 && timeoutMs > 0 && timeoutMs <= 1000;
  }
  
  /**
   * Validates all speed prediction configuration parameters
   * @returns true if all parameters are valid, false otherwise
   */
  static validateAllParameters(): boolean {
    const config = SPEED_PREDICTION_CONFIG;
    
    return (
      this.validateSpeedThreshold(config.SPEED_THRESHOLD) &&
      this.validateRadius(config.NEARBY_RADIUS) &&
      this.validateLocationSpeedParams(
        config.LOCATION_SPEED.BASE_SPEED,
        config.LOCATION_SPEED.DENSITY_FACTOR
      ) &&
      this.validatePerformanceLimits(
        config.MAX_NEARBY_VEHICLES,
        config.CALCULATION_TIMEOUT
      ) &&
      config.MIN_NEARBY_VEHICLES > 0 &&
      config.LOCATION_SPEED.MAX_DISTANCE > 0 &&
      config.DENSITY_CACHE_DURATION > 0
    );
  }
  
  /**
   * Logs configuration values at startup for debugging and verification
   * (Requirement 7.5)
   */
  static logConfigurationAtStartup(): void {
    console.log('Speed Prediction Configuration:', {
      speedThreshold: SPEED_PREDICTION_CONFIG.SPEED_THRESHOLD,
      nearbyRadius: SPEED_PREDICTION_CONFIG.NEARBY_RADIUS,
      minNearbyVehicles: SPEED_PREDICTION_CONFIG.MIN_NEARBY_VEHICLES,
      locationSpeed: SPEED_PREDICTION_CONFIG.LOCATION_SPEED,
      densityCacheDuration: SPEED_PREDICTION_CONFIG.DENSITY_CACHE_DURATION,
      maxNearbyVehicles: SPEED_PREDICTION_CONFIG.MAX_NEARBY_VEHICLES,
      calculationTimeout: SPEED_PREDICTION_CONFIG.CALCULATION_TIMEOUT,
      isValid: this.validateAllParameters()
    });
  }
}