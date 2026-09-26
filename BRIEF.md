# Offline iPhone Flight Tracker

Create a polished, self-contained HTML page for an iPhone passenger on T'way Air TW401.

## Flight
- Flight: TW401, nonstop, Smart fare
- Departure: ICN Seoul/Incheon Terminal 1
- Scheduled departure: 2026-10-03 10:10 Asia/Seoul (UTC+09:00)
- Arrival: CDG Paris/Charles de Gaulle Terminal 1
- Scheduled arrival: 2026-10-03 18:10 Europe/Paris (CEST, UTC+02:00)
- Scheduled elapsed time: 15 hours

## Core constraints
- The first viewing can be online, but every subsequent use in airplane mode must work offline.
- Final deliverable must be a single self-contained HTML file: no CDN, remote fonts, map tiles, APIs, or service worker dependency.
- It must read the iPhone's current device time with JavaScript and update the estimated flight position/progress.
- The position is a schedule-based estimate, not live aircraft telemetry or GPS.
- Use a bundled vector world/route visualization and interpolate the route along a geodesic/great-circle path between ICN and CDG.
- Clearly represent before departure, in flight, and after arrival.
- Korean UI, mobile-first, safe-area aware, readable on iPhone, touch targets at least 44px, and respect prefers-reduced-motion.
- Explain inside the page that device time must be correct and that delay/rerouting is not reflected.
- Include a small manual time simulation control for verification/demo, but make the default current device time.
