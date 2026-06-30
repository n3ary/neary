/*
 * feedConfigStore — reads per-feed timing/speed config from the SQLite blob
 * (written by the neary-gtfs pipeline) and exposes it as Svelte 5 reactive
 * state. Falls back to app-side defaults for feeds or blobs that pre-date
 * the _neary_config table.
 *
 * Consumers: map page (prediction), station board, any future component that
 * needs peak/night windows or speed estimates.
 */

import { getGtfsRepo } from '$lib/data/gtfs/repo';
import { DEFAULT_FEED_SPEED_CONFIG, type FeedSpeedConfig } from '$lib/domain/speedCascade';
import { DEFAULT_TOD_PROFILE, type TodProfile } from '$lib/domain/timeOfDay';
import { feedsStore } from './feedsStore.svelte';

function createFeedConfigStore() {
  let speedConfig = $state<FeedSpeedConfig>(DEFAULT_FEED_SPEED_CONFIG);
  let todProfile = $state<TodProfile>(DEFAULT_TOD_PROFILE);
  let dwellSec = $state<number>(20);

  $effect.root(() => {
    $effect(() => {
      const fid = feedsStore.boundFeedId;
      if (!fid) {
        speedConfig = DEFAULT_FEED_SPEED_CONFIG;
        todProfile = DEFAULT_TOD_PROFILE;
        return;
      }
      void getGtfsRepo()
        .getFeedConfig()
        .then((cfg) => {
          if (cfg.timing) {
            speedConfig = {
              ...DEFAULT_FEED_SPEED_CONFIG,
              kmh_peak: cfg.timing.speed_kmh.peak,
              kmh_offpeak: cfg.timing.speed_kmh.offpeak,
              kmh_night: cfg.timing.speed_kmh.night,
            };
            todProfile = {
              peak_windows: cfg.timing.peak_windows,
              night_window: cfg.timing.night_window,
            };
            dwellSec = cfg.timing.dwell_sec ?? 20;
          } else {
            speedConfig = DEFAULT_FEED_SPEED_CONFIG;
            todProfile = DEFAULT_TOD_PROFILE;
            dwellSec = 20;
          }
        });
    });
  });

  return {
    get speedConfig() { return speedConfig; },
    get todProfile() { return todProfile; },
    get dwellSec() { return dwellSec; },
  };
}

export const feedConfigStore = createFeedConfigStore();
