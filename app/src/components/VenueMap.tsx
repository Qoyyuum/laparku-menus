// Native stub for the venue-adjust map (spec §3): the draggable-pin
// OpenStreetMap surface is web-only — Leaflet is DOM-bound, and
// react-native-maps would need a dev build + API keys. Metro resolves
// VenueMap.web.tsx on web and this file everywhere else, so ScanTab can
// import "./VenueMap" unconditionally; native keeps the GPS + search
// paths, which already cover venue picking.
import type { VenueMapProps } from "./ScanTab";

export function VenueMap(_props: VenueMapProps) {
  return null;
}
