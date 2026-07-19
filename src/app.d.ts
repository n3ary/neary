// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  interface Window {
    /** Boot-stall watchdog, installed by the inline script in
     *  app.html. The layout calls `done()` once the app reaches a
     *  healthy state, `beat()` on bind progress, and `arm()` when a
     *  resume triggers a worker re-bind. Undefined only if the inline
     *  script itself didn't run (catastrophic parse failure). */
    __nearyBoot?: {
      /** (Re)start the stall clock. `ms` widens the window (used for
       *  feed binds with downloads in flight); beats reuse it until
       *  the next arm()/done(). */
      arm(ms?: number): void;
      done(): void;
      beat(): void;
    };
    __nearyBootHealthy?: boolean;
  }
}

export {};
