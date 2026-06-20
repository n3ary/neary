/**
 * AnimatedVehicleMarker - Smoothly animates vehicle position changes
 * Provides smooth transitions when vehicle predictions are updated
 */

import type { FC } from 'react';
import { useState, useEffect, useRef } from 'react';
import { Marker, Popup } from 'react-leaflet';
import type { EnhancedVehicleData } from '../../../utils/vehicle/vehicleEnhancementUtils';
import type { TranzyRouteResponse, TranzyTripResponse } from '../../../types/rawTranzyApi';
import { createVehicleIcon } from '../../../utils/maps/iconUtils';
import { formatTimestamp } from '../../../utils/vehicle/vehicleFormatUtils';
import { formatAbsoluteTime, formatCompactRelativeTime } from '../../../utils/time/timestampFormatUtils';
import {
  interpolateCoordinates,
  calculateAnimationProgress,
  isAnimationComplete,
  shouldAnimateMovement,
  type AnimationState
} from '../../../utils/maps/animationUtils';
import { PREDICTION_UPDATE_CYCLE } from '../../../utils/core/constants';

interface AnimatedVehicleMarkerProps {
  vehicle: EnhancedVehicleData;
  route?: TranzyRouteResponse;
  trip?: TranzyTripResponse;
  onVehicleClick?: (vehicle: EnhancedVehicleData) => void;
  isSelected?: boolean;
  color?: string;
}

export const AnimatedVehicleMarker: FC<AnimatedVehicleMarkerProps> = ({
  vehicle,
  route,
  trip,
  onVehicleClick,
  isSelected = false,
  color = '#3182CE'
}) => {
  const [currentPosition, setCurrentPosition] = useState({
    lat: vehicle.latitude,
    lon: vehicle.longitude
  });
  
  const animationStateRef = useRef<AnimationState | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const previousPositionRef = useRef({ lat: vehicle.latitude, lon: vehicle.longitude });

  // Handle position changes and start animation
  useEffect(() => {
    const newPosition = { lat: vehicle.latitude, lon: vehicle.longitude };
    const oldPosition = previousPositionRef.current;

    // Check if position actually changed and warrants animation
    if (shouldAnimateMovement(oldPosition, newPosition)) {
      // Cancel any existing animation
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      // Set up new animation
      animationStateRef.current = {
        startPosition: currentPosition, // Start from current animated position
        endPosition: newPosition,
        startTime: Date.now(),
        duration: PREDICTION_UPDATE_CYCLE / 2 // Half the prediction update interval for smooth movement
      };

      // Start animation loop
      const animate = () => {
        const animationState = animationStateRef.current;
        if (!animationState) return;

        const now = Date.now();
        
        if (isAnimationComplete(animationState.startTime, animationState.duration, now)) {
          // Animation complete
          setCurrentPosition(animationState.endPosition);
          animationStateRef.current = null;
          return;
        }

        // Calculate current position
        const progress = calculateAnimationProgress(
          animationState.startTime,
          animationState.duration,
          now
        );
        
        const interpolatedPosition = interpolateCoordinates(
          animationState.startPosition,
          animationState.endPosition,
          progress
        );
        
        // Only update state if position actually changed (prevent unnecessary re-renders)
        setCurrentPosition(prevPosition => {
          const hasChanged = Math.abs(prevPosition.lat - interpolatedPosition.lat) > 0.000001 ||
                           Math.abs(prevPosition.lon - interpolatedPosition.lon) > 0.000001;
          return hasChanged ? interpolatedPosition : prevPosition;
        });
        
        // Continue animation
        animationFrameRef.current = requestAnimationFrame(animate);
      };

      // Start the animation
      animationFrameRef.current = requestAnimationFrame(animate);
    } else {
      // No animation needed, just update position
      setCurrentPosition(newPosition);
    }

    previousPositionRef.current = newPosition;
  }, [vehicle.latitude, vehicle.longitude]); // Remove currentPosition from dependencies

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Create vehicle icon
  const icon = createVehicleIcon({ 
    color, 
    isSelected, 
    speed: vehicle.speed,
    size: 24 
  });

  // Get vehicle status text
  const getVehicleStatus = (): string => {
    if (vehicle.predictionMetadata?.isAtStation) {
      return 'At station';
    } else if (vehicle.speed === 0) {
      return 'Stopped';
    } else if (vehicle.speed < 5) {
      return 'Moving slowly';
    } else {
      return 'In transit';
    }
  };

  // Get prediction status text for popup
  const getPredictionStatus = (): string => {
    if (!vehicle.predictionMetadata) {
      return 'No prediction data';
    }
    
    const { positionApplied, timestampAge, positionMethod } = vehicle.predictionMetadata;
    
    if (!positionApplied) {
      return 'Using API position (prediction failed)';
    }
    
    const ageSeconds = Math.round(timestampAge / 1000);
    return `Predicted position (${ageSeconds}s ahead, ${positionMethod})`;
  };

  // Get speed prediction details for tooltip
  const getSpeedPredictionDetails = (): string => {
    if (!vehicle.predictionMetadata) {
      return 'No speed prediction data';
    }
    
    const { speedMethod, speedConfidence, predictedSpeed } = vehicle.predictionMetadata;
    const apiSpeed = vehicle.apiSpeed;
    
    // Show different speed if predicted differs from API
    if (speedMethod !== 'api_speed' && apiSpeed !== predictedSpeed) {
      return `${speedMethod} (${speedConfidence} confidence) - API: ${Number(apiSpeed).toFixed(2)} km/h`;
    } else {
      return `${speedMethod} (${speedConfidence} confidence)`;
    }
  };

  return (
    <Marker
      position={[currentPosition.lat, currentPosition.lon]}
      icon={icon}
      eventHandlers={{
        click: () => onVehicleClick?.(vehicle),
      }}
    >
      <Popup>
        <div style={{ minWidth: '220px' }}>
          {/* Vehicle header with route and station */}
          <div style={{ 
            fontWeight: 'bold', 
            fontSize: '16px', 
            marginBottom: '8px',
            color 
          }}>
            {route && trip ? (
              <>
                {route.route_short_name} {trip.trip_headsign} ({vehicle.label})
              </>
            ) : (
              `Vehicle ${vehicle.label}`
            )}
          </div>
          
          {/* Status with speed */}
          <div style={{ marginBottom: '4px' }}>
            <strong>Status:</strong> {getVehicleStatus()}
            {vehicle.speed > 0 && ` (${Number(vehicle.speed).toFixed(2)} km/h)`}
          </div>
          
          {/* Timestamps */}
          <div style={{ 
            fontSize: '12px', 
            color: '#666', 
            marginTop: '8px',
            borderTop: '1px solid #eee',
            paddingTop: '4px'
          }}>
            <strong>GPS:</strong> {formatAbsoluteTime(new Date(vehicle.timestamp).getTime()).replace('at ', '')}
            {(() => {
              const relativeTime = formatCompactRelativeTime(new Date(vehicle.timestamp).getTime());
              return relativeTime ? ` (${relativeTime} ago)` : '';
            })()}
          </div>
          
          {/* Vehicle metadata */}
          <div style={{ 
            fontSize: '12px', 
            color: '#666'
          }}>
            <strong>Trip:</strong> {vehicle.trip_id || 'N/A'} | <strong>ID:</strong> {vehicle.id}
          </div>
          
          {/* Prediction info */}
          {vehicle.predictionMetadata && (
            <>
              <div style={{ 
                fontSize: '12px', 
                color: '#666'
              }}>
                <strong>Position:</strong> {vehicle.predictionMetadata.positionMethod} ({vehicle.predictionMetadata.positionMethod === 'route_shape' ? 'high' : 'medium'})
              </div>
              <div style={{ 
                fontSize: '12px', 
                color: '#666'
              }}>
                <strong>Speed:</strong> {vehicle.predictionMetadata.speedMethod} ({vehicle.predictionMetadata.speedConfidence})
              </div>
              {vehicle.predictionMetadata.positionApplied && (
                <div style={{ 
                  fontSize: '12px', 
                  color: '#666'
                }}>
                  <strong>Moved:</strong> {Math.round(vehicle.predictionMetadata.predictedDistance)}m ({Math.round(vehicle.predictionMetadata.timestampAge / 1000)}s ahead)
                  {vehicle.predictionMetadata.totalDwellTime > 0 && (
                    <> | <strong>Dwell:</strong> {Math.round(vehicle.predictionMetadata.totalDwellTime / 1000)}s</>
                  )}
                </div>
              )}
            </>
          )}
          
          {/* Accessibility info */}
          {(vehicle.wheelchair_accessible === 'WHEELCHAIR_ACCESSIBLE' || 
            vehicle.bike_accessible === 'BIKE_ACCESSIBLE') && (
            <div style={{ 
              fontSize: '12px', 
              marginTop: '4px',
              color: '#4CAF50'
            }}>
              {vehicle.wheelchair_accessible === 'WHEELCHAIR_ACCESSIBLE' && '♿ '}
              {vehicle.bike_accessible === 'BIKE_ACCESSIBLE' && '🚲 '}
              Accessible
            </div>
          )}
        </div>
      </Popup>
    </Marker>
  );
};