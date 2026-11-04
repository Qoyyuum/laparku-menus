// Web venue-adjust map (spec §3): an OpenStreetMap/Leaflet surface with a
// draggable pin so the picker can correct "where am I standing" — drags
// and taps re-query the Near-you list for the dropped point. Web only:
// Leaflet needs the DOM, so Metro resolves this file for web while native
// gets the null stub in VenueMap.tsx. Tiles follow OSM's free-tier tile
// policy — standard {s}.tile.openstreetmap.org endpoints, real
// attribution, no cache-busting.
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { GeoPoint, VenueMapProps } from "./ScanTab";

// Resting view before any location lands — Bandar Seri Begawan. The pin
// is draggable from the start, so the map works without a GPS fix.
const DEFAULT_ZOOM = 12;

export function VenueMap({ position, onMove }: VenueMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markerRef = useRef<import("leaflet").Marker | null>(null);
  // Volatile props live in refs — the map binds its callbacks once at
  // mount and must see the latest onMove/position without rebinding.
  // Synced in an effect, not during render (React Compiler rule).
  const onMoveRef = useRef(onMove);
  const posRef = useRef<GeoPoint>(position);
  useEffect(() => {
    onMoveRef.current = onMove;
    posRef.current = position;
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    void (async () => {
      // Leaflet's own stylesheet must reach the DOM — tile positioning is
      // done by its classes. Metro's web build can bundle package CSS.
      await import("leaflet/dist/leaflet.css");
      // Metro's CJS interop puts the UMD export on `.default`; the
      // @types/leaflet declaration agrees (default: typeof module).
      const L = (await import("leaflet")).default;
      const el = hostRef.current;
      if (dead || !el) return;
      const start = posRef.current;
      const map = L.map(el).setView([start.lat, start.lng], start.zoom ?? DEFAULT_ZOOM);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      const marker = L.marker([start.lat, start.lng], {
        draggable: true,
        // Keep the pin on screen while it is dragged near an edge.
        autoPan: true,
        // A divIcon needs no image assets — Leaflet's default icon URL
        // resolution does not survive Metro bundling.
        icon: L.divIcon({
          className: "",
          html: '<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;background:#047857;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,.45);transform:rotate(-45deg)"></div>',
          iconSize: [26, 26],
          iconAnchor: [13, 25],
        }),
      }).addTo(map);
      marker.on("dragend", () => {
        const ll = marker.getLatLng();
        onMoveRef.current({ lat: ll.lat, lng: ll.lng });
      });
      // A tap drops the pin too — faster than dragging across town.
      map.on("click", (e) => {
        onMoveRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
      });
      mapRef.current = map;
      markerRef.current = marker;
      if (!dead) setReady(true);
      // The map lives inside an animated bottom sheet — measure again
      // once the slide-in settles or the first tiles come up blank.
      setTimeout(() => {
        if (!dead) map.invalidateSize();
      }, 400);
    })();
    return () => {
      dead = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Position sync: GPS fixes and external changes move the pin. A `zoom`
  // hint (set on fresh fixes) recenters and zooms; drags/taps just keep
  // the marker honest — the pin is already where the user put it.
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker || !ready) return;
    const ll: [number, number] = [position.lat, position.lng];
    marker.setLatLng(ll);
    if (position.zoom) map.setView(ll, position.zoom);
  }, [ready, position.lat, position.lng, position.zoom]);

  return (
    <View className="h-56 overflow-hidden rounded-lg border border-neutral-300">
      {/* Leaflet attaches to this element directly; the file only ever
          renders on web, where the export target is the DOM. */}
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
    </View>
  );
}
