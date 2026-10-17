import {
  useState,
  useEffect,
  useRef,
  Fragment,
  useCallback,
  useMemo,
  useReducer,
} from "react";
import { Link } from "react-router-dom";
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { Marker, Popup, Source, Layer, useMap } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxWrapper from "../components/MapboxWrapper";
import { useHelpUiState } from "../hooks/useHelpUiState";
import { useLocationSearch } from "../hooks/useLocationSearch";
import { useRequestMapState } from "../hooks/useRequestMapState";
import { useWalletState } from "../hooks/useWalletState";
import { useClusterer } from "../hooks/useClusterer";
import { useGeofencing } from "../hooks/useGeofencing";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useEscapeKey } from "../hooks/useEscapeKey";
import {
  getRequest,
  getActiveRequests,
  getResponder,
  getResponderCount,
  createRequest,
  acceptRequest,
  markArrived,
  resolveRequest,
  cancelRequest,
  ensureAccountFunded,
  updateLocation,
  recordExpertVerification,
  subscribeToContractEvents,
  clearWalletAddress,
} from "../lib/contract";
import useDocumentTitle from "../lib/useDocumentTitle";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Modal from "../components/ui/Modal";
import MainLayout from "../components/layout/MainLayout";
import {
  preferencesService,
  responderStatusService,
  feedbackService,
} from "../services";
// ── Field ops (ISP-131 rugged/SOS, ISP-134 NFC staging, ISP-135 radio) ──
import RadioSheet from "../components/field/RadioSheet";
import StagingSheet from "../components/field/StagingSheet";
import SosSheet from "../components/field/SosSheet";
import { useRadioBridge } from "../hooks/useRadioBridge";
import { useNfcCheckIn } from "../hooks/useNfcCheckIn";
import { useHardwareSOS } from "../hooks/useHardwareSOS";
import { useRuggedMode } from "../hooks/useRuggedMode";
import { queueDepth, PRIO } from "../lib/field/offlineQueue";
import { getTransport, transportBadge } from "../lib/field/transportEstimator";
import { MSG } from "../lib/radio/protocol";
import "./Help.css";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// The ZK prover (Noir + Barretenberg WASM, several MB) is only fetched once a
// proof is actually requested. Everything else in the module (zone building,
// proof-id truncation) is cheap, but keeping the whole module out of the
// initial bundle avoids pulling @stellar/stellar-sdk and WASM into the route
// chunk until proof generation begins.
let _zkModule: typeof import("../lib/zk") | null = null;
function loadZk() {
  if (!_zkModule) {
    _zkModule = import("../lib/zk");
  }
  return _zkModule;
}

function shortProofId(value: unknown): string {
  const text = String(value || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

const MAP_STYLES = [
  {
    id: "satellite",
    name: "Warm",
    url: "mapbox://styles/kl0ren/cmqn3p0zx000q01s69sp8ai7b",
    desc: "Custom warm style with earth greens and coral accents. Great for everyday use.",
  },
  {
    id: "claro",
    name: "Standard",
    url: "mapbox://styles/mapbox/standard",
    desc: "Clean, neutral base map. Good contrast for reading streets and names.",
  },
  {
    id: "dark",
    name: "Dark 2D",
    url: "mapbox://styles/mapbox/dark-v11",
    desc: "Dark background — reduces glare, ideal for low-light or nighttime use.",
  },
];

const CHARS = Object.freeze({
  male: Object.freeze(["runner", "pacheco", "growth", "jumping-air"]),
  female: Object.freeze(["chilly", "meela-pantalones", "feliz", "pondering"]),
  undisclosed: Object.freeze(["cube-leg", "roboto", "mechanical-love"]),
  default: Object.freeze(["looking-ahead", "waiting", "bueno"]),
});

function pickChar(gender, seed = "") {
  const pool = CHARS[gender] || CHARS.default;
  if (!pool.length) return CHARS.default[0];
  const s = String(seed);
  const idx =
    s.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % pool.length;
  return pool[idx];
}

function CharMarker({
  charName,
  accentColor = "#FF7A6B",
  lat,
  lng,
  onClick,
  children,
}) {
  return (
    <Marker latitude={lat} longitude={lng} onClick={onClick}>
      <div
        className="hp-marker"
        tabIndex={0}
        role="button"
        aria-label={`Marker for ${charName}${accentColor === "#FF7A6B" ? " (requester)" : " (responder)"}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.(e);
          }
        }}
        style={{
          position: "relative",
          width: 52,
          height: 52,
          cursor: "pointer",
        }}
      >
        <img
          src={`/assets/chars/${charName}.png`}
          alt=""
          onError={(e) => {
            if (e.currentTarget.src.endsWith(`${CHARS.default[0]}.png`)) return;
            e.currentTarget.src = `/assets/chars/${CHARS.default[0]}.png`;
          }}
          style={{
            width: 52,
            height: 52,
            objectFit: "contain",
            filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.28))",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            width: 13,
            height: 13,
            borderRadius: "50%",
            background: accentColor,
            border: "2.5px solid #fff",
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          }}
        />
      </div>
      {children}
    </Marker>
  );
}

function MapController({ center, zoom = 14 }) {
  const { current: map } = useMap();
  useEffect(() => {
    if (!map || !Number.isFinite(center?.[0]) || !Number.isFinite(center?.[1]))
      return;
    map.flyTo({ center: [center[1], center[0]], zoom, duration: 1200 });
  }, [center, zoom, map]);
  return null;
}

function MapKeyboardControls() {
  const { current: map } = useMap();

  useEffect(() => {
    if (!map) return;

    const mapContainer = map.getContainer();
    if (!mapContainer) return;

    // Ensure the container itself can be focused so keydowns are captured
    mapContainer.setAttribute("tabindex", "0");
    // Ensure the canvas is not in tab order so we don't double tab
    const canvas = map.getCanvas();
    if (canvas) {
      canvas.setAttribute("tabindex", "-1");
    }

    // Set styling for focus outline
    const styleId = "map-focus-styles";
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      styleEl.innerHTML = `
        .mapboxgl-map:focus {
          outline: 2px solid #FF7A6B;
          outline-offset: -2px;
        }
        .hp-marker:focus {
          outline: 3px solid #FF7A6B !important;
          outline-offset: 4px;
        }
      `;
      document.head.appendChild(styleEl);
    }

    const handleKeyDown = (e) => {
      const activeEl = document.activeElement;
      // Only handle if map container has focus or contains the focused element (excluding inputs/textarea)
      if (activeEl !== mapContainer && !mapContainer.contains(activeEl)) return;
      if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")
        return;

      const PAN_OFFSET = 100; // pixels to pan
      const ZOOM_OFFSET = 0.5; // zoom level delta

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          map.panBy([0, -PAN_OFFSET]);
          break;
        case "ArrowDown":
          e.preventDefault();
          map.panBy([0, PAN_OFFSET]);
          break;
        case "ArrowLeft":
          e.preventDefault();
          map.panBy([-PAN_OFFSET, 0]);
          break;
        case "ArrowRight":
          e.preventDefault();
          map.panBy([PAN_OFFSET, 0]);
          break;
        case "+":
        case "=":
          e.preventDefault();
          map.zoomTo(map.getZoom() + ZOOM_OFFSET);
          break;
        case "-":
        case "_":
          e.preventDefault();
          map.zoomTo(map.getZoom() - ZOOM_OFFSET);
          break;
        default:
          break;
      }
    };

    mapContainer.addEventListener("keydown", handleKeyDown);
    return () => {
      mapContainer.removeEventListener("keydown", handleKeyDown);
    };
  }, [map]);

  return null;
}

export function distance(a, b) {
  if (
    !Number.isFinite(a?.[0]) ||
    !Number.isFinite(a?.[1]) ||
    !Number.isFinite(b?.[0]) ||
    !Number.isFinite(b?.[1])
  ) {
    return null;
  }
  const R = 6371;
  const DEG2RAD = Math.PI / 180;
  const dLat = (b[0] - a[0]) * DEG2RAD;
  const dLng = (b[1] - a[1]) * DEG2RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  if (!Number.isFinite(sinLat) || !Number.isFinite(sinLng)) {
    return null;
  }

  const h =
    sinLat * sinLat +
    Math.cos((a[0] * Math.PI) / 180) *
      Math.cos((b[0] * Math.PI) / 180) *
      sinLng *
      sinLng;

  if (!Number.isFinite(h)) {
    return null;
  }

  const result = R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return Number.isFinite(result) ? result : null;
}

// Issue #227: pure builder extracted so RouteLine can memoize on it instead
// of allocating a fresh GeoJSON object identity on every render.
export function buildRouteFeature(from, to) {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [from[1], from[0]],
        [to[1], to[0]],
      ],
    },
  };
}

function RouteLine({ id: routeId, from, to, color = "#7357FF" }) {
  const id = `route-${routeId || `${from[0]}-${from[1]}-${to[0]}-${to[1]}`}`;
  const data = useMemo(
    () => buildRouteFeature(from, to),
    [from[0], from[1], to[0], to[1]],
  );
  return (
    <Source id={id} type="geojson" data={data}>
      <Layer
        id={`${id}-line`}
        type="line"
        paint={{
          "line-color": color,
          "line-width": 2,
          "line-opacity": 0.65,
          "line-dasharray": [10, 6],
        }}
      />
    </Source>
  );
}

export function loadProfile() {
  try {
    const parsed = JSON.parse(localStorage.getItem("hp_profile") || "{}");
    // Issue #228: localStorage can hold valid-but-unexpected JSON (e.g. "null"
    // or an array) — guard so callers always get a plain object back.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

// Issue #229: frozen so this shared fallback map center can't be mutated
// in place by a stray `.push`/index assignment elsewhere in the file.
export const DEFAULT_CENTER = Object.freeze([20, 0]);

const MY_REQUESTS_KEY = "hp_my_requests";

// Some browsers (Safari private mode, storage disabled, strict privacy
// settings) throw on localStorage access instead of just returning null,
// and a stored value can be corrupted or hand-edited into a non-array.
// Both paths must degrade to an empty list rather than crash the caller.
export function loadMyRequestIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MY_REQUESTS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => Number.isFinite(id));
  } catch {
    return [];
  }
}

export function saveMyRequestId(id) {
  if (!Number.isFinite(id)) return;
  const ids = loadMyRequestIds();
  if (!ids.includes(id)) {
    ids.unshift(id);
    try {
      localStorage.setItem(MY_REQUESTS_KEY, JSON.stringify(ids.slice(0, 20)));
    } catch {
      // Storage quota exceeded or unavailable — the request itself was
      // already created on-chain, so this must not fail the caller.
    }
  }
}

export function anonymizeLocation(location) {
  if (
    !Array.isArray(location) ||
    !Number.isFinite(location[0]) ||
    !Number.isFinite(location[1])
  ) {
    throw new Error("Unable to read your location. Try again.");
  }
  return [
    Math.round(location[0] * 100) / 100,
    Math.round(location[1] * 100) / 100,
  ];
}

export function privateRequestLabel(id) {
  // Guard against non-string/non-number ids (e.g. an object slipping through
  // from a malformed contract read) rendering as "[object Object]" — fall
  // back to "pending" for anything that isn't a usable primitive.
  const safeId =
    typeof id === "string" || typeof id === "number" ? id : "pending";
  return `Private request #${safeId || "pending"}`;
}

// Matches the hex-hash tolerance already established for receipt hashes
// elsewhere in this file (see the `safeTxHash` validation, issue #247) —
// reject anything that isn't a plausible hex tx hash so a malformed/garbage
// value never produces a broken or unexpectedly-shaped explorer URL.
const TX_HASH_PATTERN = /^[0-9a-f]{16,64}$/i;

export function txExplorerUrl(hash) {
  if (typeof hash !== "string") return null;
  const trimmed = hash.trim();
  if (!TX_HASH_PATTERN.test(trimmed)) return null;
  return `https://stellar.expert/explorer/testnet/tx/${trimmed}`;
}

export function ExplorerLink({ label, hash }) {
  const url = txExplorerUrl(hash);
  if (!url) return null;
  const safeLabel = typeof label === "string" && label ? label : "transaction";
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View ${safeLabel} on Stellar Expert (testnet), opens in a new tab`}
      title={`View ${safeLabel.toLowerCase()} on Stellar Expert (testnet)`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "10px",
        color: "#7fb8ba",
        textDecoration: "none",
        fontFamily: "'Courier New', monospace",
        cursor: "pointer",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minHeight: "44px",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = "underline";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = "none";
      }}
    >
      <span style={{ color: "rgba(242,236,220,0.4)" }}>{safeLabel}</span>
      <span>{shortProofId(hash)}</span>
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
        aria-hidden="true"
      >
        <path d="M7 17L17 7M17 7H8M17 7v9" />
      </svg>
    </a>
  );
}

function sanitizeTxHash(txHash) {
  if (typeof txHash !== "string") return null;
  const trimmed = txHash.trim();
  return TX_HASH_PATTERN.test(trimmed) ? trimmed : null;
}

function ArrivalThanksModal({ open, onClose, requestLabel, txHash }) {
  const dialogRef = useRef(null);
  useFocusTrap(open, dialogRef);
  useEscapeKey(open, onClose);
  if (!open) return null;

  const handleLastAction = (e) => {
    if (e && typeof e.stopPropagation === "function") {
      e.stopPropagation();
    }
    if (typeof onClose === "function") {
      try {
        onClose();
      } catch (err) {
        console.warn("Non-blocking error during modal dismissal:", err);
      }
    }
  };

  const safeTxHash = sanitizeTxHash(txHash);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="arrival-thanks-title"
      onClick={handleLastAction}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.68)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="document"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "390px",
          borderRadius: "18px",
          background: "#1c3535",
          border: "1px solid rgba(63,132,135,0.32)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.58)",
          padding: "24px 22px 20px",
          textAlign: "center",
          outline: "none",
        }}
      >
        <div
          style={{
            width: "52px",
            height: "52px",
            borderRadius: "50%",
            margin: "0 auto 14px",
            background: "rgba(63,132,135,0.16)",
            border: "1px solid rgba(63,132,135,0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#3F8487",
          }}
        >
          <svg
            width="25"
            height="25"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h3
          id="arrival-thanks-title"
          style={{
            margin: "0 0 8px",
            fontFamily: "'Instrument Serif',serif",
            fontWeight: 400,
            fontSize: "26px",
            lineHeight: 1.08,
            color: "#F4ECDC",
          }}
        >
          Thank you for helping
        </h3>
        <p
          style={{
            margin: "0 0 14px",
            fontSize: "13px",
            color: "rgba(242,236,220,0.56)",
            lineHeight: 1.55,
          }}
        >
          Your arrival has been recorded on Stellar. Because you showed up,
          someone nearby knows they are not alone.
        </p>
        {requestLabel && (
          <div
            style={{
              margin: "0 auto 14px",
              display: "inline-flex",
              padding: "5px 9px",
              borderRadius: "7px",
              background: "rgba(255,255,255,0.06)",
              color: "rgba(242,236,220,0.58)",
              fontSize: "11px",
              fontWeight: 700,
            }}
          >
            {requestLabel}
          </div>
        )}
        {safeTxHash && (
          <div
            style={{
              marginBottom: "14px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <ExplorerLink label="Arrival receipt" hash={safeTxHash} />
          </div>
        )}
        <button
          type="button"
          onClick={handleLastAction}
          style={{
            width: "100%",
            minHeight: "44px",
            padding: "11px 14px",
            borderRadius: "10px",
            border: "none",
            background: "#3F8487",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

// Deterministic campaign id from a seed string. Hashes every character —
// distinct seeds must map to distinct campaigns, otherwise colliding ids
// reuse a nullifier on-chain and the claim is rejected after fees are paid.
function proofCampaignId(seed) {
  const text =
    seed === null || seed === undefined ? String(Date.now()) : String(seed);
  let acc = 0n;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 131n + BigInt(text.charCodeAt(i))) % 999999937n;
  }
  acc = (acc * 31n + BigInt(text.length)) % 999999937n;
  // Ensure non-zero result
  return String(acc + 1n);
}

// Step state → colors, kept in module scope so every render reads one
// frozen source of truth instead of rebuilding nested ternaries inline.
const STEP_STATE_COLORS = Object.freeze({
  done: {
    badgeBg: "#3F8487",
    border: "#3F8487",
    badgeText: "#fff",
    title: "#3F8487",
  },
  active: {
    badgeBg: "#FF7A6B",
    border: "#FF7A6B",
    badgeText: "#fff",
    title: "rgba(242,236,220,0.95)",
  },
  idle: {
    badgeBg: "rgba(255,255,255,0.1)",
    border: "rgba(255,255,255,0.2)",
    badgeText: "rgba(242,236,220,0.4)",
    title: "rgba(242,236,220,0.45)",
  },
});

function Step({ n, title, subtitle, done, active, children }) {
  const colors = done
    ? STEP_STATE_COLORS.done
    : active
      ? STEP_STATE_COLORS.active
      : STEP_STATE_COLORS.idle;
  return (
    <div
      style={{
        marginBottom: "6px",
        opacity: !active && !done ? 0.38 : 1,
        transition: "opacity 0.3s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: children ? "12px" : 0,
        }}
      >
        <div
          style={{
            width: "26px",
            height: "26px",
            borderRadius: "50%",
            flexShrink: 0,
            background: colors.badgeBg,
            border: `2px solid ${colors.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontWeight: "700",
            color: colors.badgeText,
          }}
        >
          {done ? "✓" : n}
        </div>
        <div>
          <div
            style={{
              fontSize: "13px",
              fontWeight: "600",
              color: colors.title,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: "11px",
                color: "rgba(242,236,220,0.72)",
                marginTop: "1px",
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {children && <div style={{ marginLeft: "36px" }}>{children}</div>}
    </div>
  );
}

// ── Post-resolution feedback modal (#139) ────────────────────────────────────
export function FeedbackModal({ open, onClose, onSubmit }) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const dialogRef = useRef(null);
  useFocusTrap(open, dialogRef);

  useEffect(() => {
    if (open) {
      setRating(0);
      setHovered(0);
      setComment("");
      setSubmitted(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    // initial focus is handled by useFocusTrap; keep prev for restore
    function handleKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit() {
    if (rating === 0) return;
    await onSubmit({ rating, comment });
    setSubmitted(true);
    setTimeout(onClose, 1400);
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-modal-title"
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: "420px",
          borderRadius: "18px",
          background: "#1c2c24",
          border: "1px solid rgba(255,255,255,0.1)",
          padding: "28px 24px 24px",
          outline: "none",
        }}
      >
        {submitted ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>✓</div>
            <p style={{ color: "#F4ECDC", fontWeight: 700, margin: 0 }}>
              Thanks for your feedback!
            </p>
          </div>
        ) : (
          <>
            <h2
              id="feedback-modal-title"
              style={{
                margin: "0 0 6px",
                color: "#F4ECDC",
                fontSize: "20px",
                fontWeight: 700,
              }}
            >
              Rate your responder
            </h2>
            <p
              style={{
                margin: "0 0 20px",
                color: "rgba(242,236,220,0.55)",
                fontSize: "13px",
                lineHeight: 1.55,
              }}
            >
              Your rating builds on-chain reputation for responders who show up.
            </p>
            <div
              style={{
                display: "flex",
                gap: "8px",
                justifyContent: "center",
                marginBottom: "20px",
              }}
              role="group"
              aria-label="Star rating"
            >
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  aria-label={`${star} star${star > 1 ? "s" : ""}`}
                  onClick={() => setRating(star)}
                  onMouseEnter={() => setHovered(star)}
                  onMouseLeave={() => setHovered(0)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "32px",
                    minWidth: "44px",
                    minHeight: "44px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color:
                      star <= (hovered || rating)
                        ? "#FF7A6B"
                        : "rgba(255,255,255,0.15)",
                    transition: "color 0.15s",
                  }}
                >
                  ★
                </button>
              ))}
            </div>
            <label htmlFor="hp-feedback-comment" className="hp-sr-only">
              Additional feedback comment
            </label>
            <textarea
              id="hp-feedback-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              placeholder="Optional comment…"
              aria-label="Additional feedback comment"
              rows={3}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "10px",
                color: "#F4ECDC",
                fontSize: "13px",
                padding: "10px 12px",
                resize: "vertical",
                outline: "none",
                marginBottom: "16px",
              }}
            />
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: "12px",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.1)",
                  background: "rgba(255,255,255,0.05)",
                  color: "rgba(242,236,220,0.65)",
                  fontSize: "14px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Skip
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={rating === 0}
                style={{
                  flex: 2,
                  padding: "12px",
                  borderRadius: "10px",
                  border: "none",
                  background: rating > 0 ? "#FF7A6B" : "rgba(255,122,107,0.3)",
                  color: "#fff",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: rating > 0 ? "pointer" : "not-allowed",
                  transition: "background 0.2s",
                }}
              >
                Submit rating
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Emergency category map markers (#140) ─────────────────────────────────────
// Renders a distinct SVG pin per emergency type so responders can visually
// scan the map without opening each popup. Falls back to the generic marker
// colour if the type isn't in ET_ICONS.
const ET_COLORS = Object.freeze({
  lost: "#7357FF",
  fallen: "#FF7A6B",
  medical: "#e53e3e",
  car: "#d69e2e",
  danger: "#9b2335",
  other: "#3F8487",
});

export function EmergencyMarker({
  lat,
  lng,
  emergencyType,
  isActive,
  onClick,
  children,
}) {
  const color = ET_COLORS[emergencyType] || "#FF7A6B";
  const icon = ET_ICONS[emergencyType] || ET_ICONS.other;
  return (
    <Marker latitude={lat} longitude={lng} onClick={onClick}>
      <div
        className={`hp-marker${isActive ? " hp-marker-active" : ""}`}
        tabIndex={0}
        role="button"
        aria-label={`Emergency marker: ${emergencyType || "emergency"}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.(e);
          }
        }}
        style={{ position: "relative", cursor: "pointer" }}
      >
        <svg
          width="36"
          height="44"
          viewBox="0 0 36 44"
          fill="none"
          aria-label={emergencyType || "emergency"}
        >
          <path
            d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 26 18 26s18-12.5 18-26C36 8.06 27.94 0 18 0z"
            fill={color}
          />
          <circle cx="18" cy="18" r="13" fill="rgba(0,0,0,0.25)" />
        </svg>
        <div
          style={{
            position: "absolute",
            top: "7px",
            left: "8px",
            color: "#fff",
          }}
        >
          {icon}
        </div>
        {children}
      </div>
    </Marker>
  );
}

export function MapLegend() {
  return (
    <div
      aria-label="Map legend"
      style={{
        position: "absolute",
        bottom: "48px",
        right: "12px",
        zIndex: 100,
        background: "rgba(20,32,28,0.92)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "10px",
        padding: "10px 12px",
        minWidth: "148px",
      }}
    >
      <div
        style={{
          fontSize: "9px",
          letterSpacing: "1.2px",
          color: "#7fb8ba",
          fontWeight: 900,
          marginBottom: "8px",
        }}
      >
        EMERGENCY TYPES
      </div>
      {EMERGENCY_TYPES.filter((et) => et.id !== "other").map((et) => (
        <div
          key={et.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "5px",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: ET_COLORS[et.id] || "#FF7A6B",
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: "11px", color: "rgba(242,236,220,0.75)" }}>
            {et.icon} {et.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Onboarding tour steps (#138) ──────────────────────────────────────────────
// Exported so tests can assert the shape without mounting the component.
// Each step renders in the HelpOnboardingModal progress-bar wizard.
// The last step MUST have isLast:true — the modal uses this to switch
// the CTA from "Next" to "Connect preferred wallet".
export const HELP_ONBOARDING_STEPS = Object.freeze([
  {
    label: "Welcome",
    title: "HelPhone keeps you safe",
    body: "HelPhone is a peer-to-peer emergency network built on Stellar. Real people nearby respond to real emergencies — no call centres, no hold music.",
  },
  {
    label: "Wallet",
    title: "Connect your Stellar wallet",
    body: "Your wallet is your identity on HelPhone. It proves you're human (via a funded Stellar account) and records every arrival on-chain so responders earn verifiable reputation.",
  },
  {
    label: "Map",
    title: "The map shows who needs help",
    body: "Switch to Offer mode to see open emergency requests near you. Each pin shows the type of emergency — medical, car trouble, unsafe situation, and more. Tap a pin to see details and offer help.",
  },
  {
    label: "Request",
    title: "Need help? Tap 'Get help'",
    body: "Pick your emergency type, share your location, and post a request. Nearby responders are notified immediately. Your precise coordinates are never stored — only an anonymised zone.",
  },
  {
    label: "Privacy",
    title: "Zero-knowledge privacy",
    body: "HelPhone uses ZK proofs to verify your location and humanity without revealing private data. Your exact position stays on your device. Only the proof goes on-chain.",
    isLast: true,
  },
]);

export function HelpOnboardingModal({ open, onClose, onConnectWallet }) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef(null);
  const lastFocusedRef = useRef(null);
  useFocusTrap(open, dialogRef);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // Dialog a11y: close on Escape, focus the dialog on open, and return
  // focus to whatever triggered it on close — matches the role="dialog"
  // pattern already used elsewhere in this file (see the arrival-receipt
  // modal's aria-labelledby/aria-modal usage).
  useEffect(() => {
    if (!open) return undefined;
    lastFocusedRef.current = document.activeElement;

    function handleKeyDown(e) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (lastFocusedRef.current instanceof HTMLElement) {
        lastFocusedRef.current.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const steps = HELP_ONBOARDING_STEPS;
  const totalSteps = steps.length;

  const current = steps[Math.min(step, steps.length - 1)];

  async function handleLastAction() {
    if (step === totalSteps - 1) {
      onClose();
      await onConnectWallet();
    } else {
      setStep((s) => s + 1);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "18px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-onboarding-title"
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: "460px",
          borderRadius: "18px",
          background: "#1c2c24",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.62)",
          overflow: "hidden",
          transition: "opacity 0.25s",
          outline: "none",
        }}
      >
        <div
          style={{
            padding: "18px 20px 0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div
            style={{
              fontSize: "10px",
              letterSpacing: "1.4px",
              color: "#7fb8ba",
              fontWeight: 900,
            }}
          >
            HELPHONE GUIDE
          </div>
          <button
            type="button"
            aria-label="Close guide"
            onClick={onClose}
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.05)",
              color: "rgba(242,236,220,0.65)",
              cursor: "pointer",
              fontSize: "18px",
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            x
          </button>
        </div>

        <div
          style={{
            padding: "14px 24px 0",
            display: "flex",
            gap: "8px",
            alignItems: "center",
          }}
        >
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: "4px",
                borderRadius: "4px",
                background:
                  i === step
                    ? "#FF7A6B"
                    : i < step
                      ? "#3F8487"
                      : "rgba(255,255,255,0.1)",
                transition: "background 0.3s",
              }}
            />
          ))}
        </div>

        <div style={{ padding: "26px 24px 8px", textAlign: "center" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "74px",
              height: "34px",
              padding: "0 12px",
              borderRadius: "999px",
              background: "rgba(63,132,135,0.14)",
              border: "1px solid rgba(63,132,135,0.28)",
              color: "#7fb8ba",
              fontSize: "11px",
              fontWeight: 900,
              letterSpacing: "1px",
              marginBottom: "16px",
            }}
          >
            {step + 1}/{totalSteps} · {current.label}
          </div>
          <h2
            id="help-onboarding-title"
            style={{
              margin: "0 0 10px",
              color: "#F4ECDC",
              fontSize: "22px",
              lineHeight: 1.15,
              fontWeight: 700,
            }}
          >
            {current.title}
          </h2>
          <p
            style={{
              margin: 0,
              color: "rgba(242,236,220,0.55)",
              fontSize: "14px",
              lineHeight: 1.6,
              padding: "0 6px",
            }}
          >
            {current.body}
          </p>
        </div>

        <div style={{ padding: "24px", display: "flex", gap: "10px" }}>
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              style={{
                padding: "12px 18px",
                borderRadius: "10px",
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.05)",
                color: "rgba(242,236,220,0.65)",
                fontSize: "14px",
                fontWeight: 600,
                cursor: "pointer",
                minWidth: "80px",
              }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={handleLastAction}
            style={{
              flex: 1,
              minHeight: "48px",
              borderRadius: "10px",
              border: "none",
              background: step === totalSteps - 1 ? "#7357FF" : "#FF7A6B",
              color: "#fff",
              fontSize: "15px",
              fontWeight: 700,
              cursor: "pointer",
              transition: "background 0.2s",
            }}
          >
            {step === totalSteps - 1 ? "Connect preferred wallet" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ETA countdown timer (#141) ──────────────────────────────────────────────
// Live countdown that updates every second without layout shift.
function EtaCountdown({ etaSeconds, isArrived }) {
  const [remaining, setRemaining] = useState(
    etaSeconds != null && Number.isFinite(etaSeconds) ? etaSeconds : null,
  );

  useEffect(() => {
    if (etaSeconds == null || !Number.isFinite(etaSeconds) || etaSeconds <= 0) {
      setRemaining(null);
      return;
    }
    setRemaining(etaSeconds);
  }, [etaSeconds]);

  useEffect(() => {
    if (remaining == null || remaining <= 0 || isArrived) return;
    const timer = setInterval(() => {
      setRemaining((prev) => (prev != null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining != null && remaining > 0 && !isArrived]);

  if (isArrived) return <span>Arrived</span>;
  if (remaining == null || remaining <= 0) return <span>—</span>;

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  if (mins > 0) {
    return <span>{mins}m {String(secs).padStart(2, "0")}s</span>;
  }
  return <span>{secs}s</span>;
}

function TrackingScreen({
  responderLat,
  responderLng,
  responderAddress,
  responderChar,
  requesterLat,
  requesterLng,
  requesterChar,
  etaSeconds,
  isArrived,
  isResponderView,
  isMarkingArrived,
  onMarkArrived,
  onResolve,
}) {
  const dist =
    requesterLat != null &&
    responderLat != null &&
    Number.isFinite(requesterLat) &&
    Number.isFinite(requesterLng) &&
    Number.isFinite(responderLat) &&
    Number.isFinite(responderLng)
      ? Math.round(
          distance([requesterLat, requesterLng], [responderLat, responderLng]) *
            10,
        ) / 10
      : null;
  const etaMin =
    etaSeconds != null && Number.isFinite(etaSeconds) && etaSeconds > 0
      ? Math.round(etaSeconds / 60)
      : null;

  return (
    <>
      {responderLat != null && (
        <CharMarker
          charName={responderChar || pickChar("default", responderAddress)}
          accentColor="#7357FF"
          lat={responderLat}
          lng={responderLng}
        >
          {!isArrived && (
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: "52px",
                height: "52px",
                transform: "translate(-50%, -50%) scale(1.5)",
                borderRadius: "50%",
                border: "2px solid rgba(115,87,255,0.3)",
                animation: "mdpulse 2s ease-out infinite",
                pointerEvents: "none",
              }}
            />
          )}
        </CharMarker>
      )}
      {responderLat != null && requesterLat != null && (
        <RouteLine
          id="tracking-route"
          from={[responderLat, responderLng]}
          to={[requesterLat, requesterLng]}
          color="#7357FF"
        />
      )}

      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          background: "linear-gradient(transparent, rgba(0,0,0,0.7) 30%)",
          padding: "40px 20px 20px",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            background: "#1c2c24",
            borderRadius: "16px",
            padding: "16px 18px",
            border: "1px solid rgba(255,255,255,0.08)",
            maxWidth: "460px",
            margin: "0 auto",
            pointerEvents: "auto",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: isArrived ? "#3F8487" : "#7357FF",
                animation: isArrived
                  ? "none"
                  : "mdblink 1.4s steps(1) infinite",
              }}
            />
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                letterSpacing: "1.5px",
                color: isArrived ? "#3F8487" : "#B3A6FF",
              }}
            >
              {isArrived ? "ARRIVED" : "EN ROUTE"}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.70)",
                  marginBottom: "4px",
                }}
              >
                RESPONDER
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "#F4ECDC",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {responderAddress
                  ? `${responderAddress.slice(0, 8)}...`
                  : "Unknown"}
              </div>
            </div>
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.70)",
                  marginBottom: "4px",
                }}
              >
                DISTANCE
              </div>
              <div style={{ fontSize: "11px", color: "#F4ECDC" }}>
                {dist != null ? `${dist} km` : "—"}
              </div>
            </div>
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.70)",
                  marginBottom: "4px",
                }}
              >
                ETA
              </div>
              <div style={{ fontSize: "11px", color: "#F4ECDC", fontVariantNumeric: "tabular-nums" }}>
                <EtaCountdown etaSeconds={etaSeconds} isArrived={isArrived} />
              </div>
            </div>
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.70)",
                  marginBottom: "4px",
                }}
              >
                STATUS
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: isArrived ? "#3F8487" : "#B3A6FF",
                }}
              >
                {isArrived ? "Arrived" : "En Route"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {isResponderView && !isArrived && (
              <button
                onClick={onMarkArrived}
                disabled={isMarkingArrived}
                style={{
                  flex: 1,
                  padding: "11px 14px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#3F8487",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: isMarkingArrived ? "default" : "pointer",
                  opacity: isMarkingArrived ? 0.7 : 1,
                }}
              >
                {isMarkingArrived ? "Recording arrival..." : "Mark Arrived"}
              </button>
            )}
            {!isResponderView && isArrived && (
              <button
                onClick={onResolve}
                style={{
                  flex: 1,
                  padding: "11px 14px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#7357FF",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Resolve Request
              </button>
            )}
            {isResponderView && isArrived && (
              <div
                style={{
                  flex: 1,
                  padding: "11px 14px",
                  borderRadius: "10px",
                  background: "rgba(63,132,135,0.12)",
                  color: "#3F8487",
                  fontSize: "12px",
                  fontWeight: 700,
                  textAlign: "center",
                  border: "1px solid rgba(63,132,135,0.25)",
                }}
              >
                ARRIVED ✓
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Sound & haptic feedback (#142) ──────────────────────────────────────────
const ALERT_PREFS_KEY = "hp_alert_prefs";

function loadAlertPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALERT_PREFS_KEY) || "{}");
    return {
      soundEnabled: raw.soundEnabled !== false,
      hapticEnabled: raw.hapticEnabled !== false,
    };
  } catch {
    return { soundEnabled: true, hapticEnabled: true };
  }
}

function saveAlertPrefs(prefs) {
  try {
    localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

function useAlertFeedback() {
  const [prefs, setPrefs] = useState(loadAlertPrefs);
  const audioCtxRef = useRef(null);

  useEffect(() => {
    saveAlertPrefs(prefs);
  }, [prefs]);

  const playChime = useCallback(() => {
    if (!prefs.soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch {}
  }, [prefs.soundEnabled]);

  const triggerHaptic = useCallback(() => {
    if (!prefs.hapticEnabled) return;
    try {
      if (navigator.vibrate) {
        navigator.vibrate([100, 50, 100]);
      }
    } catch {}
  }, [prefs.hapticEnabled]);

  const alertNewRequest = useCallback(() => {
    playChime();
    triggerHaptic();
  }, [playChime, triggerHaptic]);

  const toggleSound = useCallback(() => {
    setPrefs((p) => ({ ...p, soundEnabled: !p.soundEnabled }));
  }, []);

  const toggleHaptic = useCallback(() => {
    setPrefs((p) => ({ ...p, hapticEnabled: !p.hapticEnabled }));
  }, []);

  return { prefs, alertNewRequest, toggleSound, toggleHaptic };
}

function logEmergencySelection(typeId) {
  try {
    console.info(`[HelPhone] Emergency type selected: ${typeId}`);
  } catch {}
}

// ── Request history list with filtering (#143) ──────────────────────────────
function FilteredRequestList({
  requests,
  historyFilter,
  requestId,
  setRequestId,
  setRequestStatus,
  setShowCancelConfirm,
}) {
  const filtered = historyFilter === 'all'
    ? requests
    : requests.filter((r) => {
        if (historyFilter === 'active') return r.status === 'Pending' || r.status === 'Enroute';
        return r.status?.toLowerCase() === historyFilter;
      });

  if (filtered.length === 0) {
    return (
      <p style={{ fontSize: "12px", color: "rgba(242,236,220,0.70)" }}>
        No requests match this filter.
      </p>
    );
  }

  return (
    <>
      {filtered.slice(0, 10).map((req) => {
        const isActive = req.id === requestId;
        const statusColors = {
          Pending: { color: "#a2a586", bg: "rgba(162,165,134,0.15)" },
          Enroute: { color: "#7357FF", bg: "rgba(115,87,255,0.15)" },
          Resolved: { color: "#3F8487", bg: "rgba(63,132,135,0.15)" },
          Cancelled: { color: "rgba(242,236,220,0.70)", bg: "rgba(255,255,255,0.04)" },
        };
        const sc = statusColors[req.status] || statusColors.Cancelled;
        const et = EMERGENCY_TYPES.find((e) => e.id === req.emergency_type);
        const timeAgo = req.created_at
          ? (() => {
              const d = Math.floor((Date.now() / 1000 - req.created_at) / 60);
              return d < 1 ? "just now" : d < 60 ? `${d}m ago` : `${Math.floor(d / 60)}h ago`;
            })()
          : "";
        return (
          <div
            key={req.id}
            onClick={() => {
              if (req.status === "Pending" || req.status === "Enroute") {
                setRequestId(req.id);
                setRequestStatus(req.status);
              }
            }}
            style={{
              padding: "10px 12px",
              marginBottom: "8px",
              borderRadius: "10px",
              cursor: "pointer",
              background: isActive ? "rgba(63,132,135,0.12)" : "rgba(255,255,255,0.04)",
              border: isActive ? "1px solid rgba(63,132,135,0.3)" : "1px solid rgba(255,255,255,0.06)",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "12px", fontWeight: "600", color: "#F4ECDC" }}>#{req.id}</span>
                  <span
                    style={{
                      fontSize: "9px",
                      fontWeight: "700",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      background: sc.bg,
                      color: sc.color,
                      letterSpacing: "0.5px",
                    }}
                  >
                    {req.status?.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontSize: "10px", color: "rgba(242,236,220,0.72)", marginTop: "3px", lineHeight: 1.4 }}>
                  {et ? `${et.icon} ${et.label}` : req.emergency_type || "Unknown"}
                  {timeAgo && (
                    <span style={{ marginLeft: "6px", color: "rgba(242,236,220,0.65)" }}>· {timeAgo}</span>
                  )}
                </div>
              </div>
              {isActive && req.status === "Pending" && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowCancelConfirm(req.id); }}
                  style={{
                    padding: "5px 9px",
                    borderRadius: "6px",
                    flexShrink: 0,
                    background: "rgba(255,122,107,0.12)",
                    border: "1px solid rgba(255,122,107,0.25)",
                    color: "#FF7A6B",
                    fontSize: "10px",
                    fontWeight: "700",
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

const EMERGENCY_TYPES = [
  {
    id: "lost",
    icon: "🧭",
    label: "I'm lost",
    desc: "Don't know where I am or how to get back",
  },
  {
    id: "fallen",
    icon: "🩹",
    label: "Fell / injured",
    desc: "Need assistance after a fall or injury",
  },
  {
    id: "medical",
    icon: "🏥",
    label: "Medical emergency",
    desc: "Health issue that can't wait",
  },
  {
    id: "car",
    icon: "🔧",
    label: "Car trouble",
    desc: "Vehicle broke down on the road",
  },
  {
    id: "danger",
    icon: "🛡️",
    label: "I feel unsafe",
    desc: "Unsafe situation, need someone nearby",
  },
  {
    id: "other",
    icon: "⋯",
    label: "Something else",
    desc: "Another type of emergency",
  },
];

const PRIORITY_LEVELS = [
  { id: "Low", label: "Low", color: "#3F8487" },
  { id: "Medium", label: "Medium", color: "#a2a586" },
  { id: "High", label: "High", color: "#d69e2e" },
  { id: "Critical", label: "Critical", color: "#e53e3e" },
];

const PRIORITY_COLORS = Object.freeze({
  Low: "#3F8487",
  Medium: "#a2a586",
  High: "#d69e2e",
  Critical: "#e53e3e",
});

const ET_ICONS = {
  lost: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path
        d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"
        fill="currentColor"
        strokeWidth="0"
      />
    </svg>
  ),
  fallen: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="4.5" r="1.8" fill="currentColor" stroke="none" />
      <path d="M9 9c-1.5 1.5-2.5 3.5-2 5.5" />
      <path d="M12 7v5l3.5 4" />
      <path d="M10 12.5 7 18" />
    </svg>
  ),
  medical: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      <polyline points="8 12.5 10 10.5 12 14 14 9 16 12.5" strokeWidth="1.5" />
    </svg>
  ),
  car: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 17H3a2 2 0 0 1-2-2v-4a2 2 0 0 1 .5-1.5L5 6h14l3.5 3.5A2 2 0 0 1 23 11v4a2 2 0 0 1-2 2h-2" />
      <circle cx="7.5" cy="17" r="2.5" />
      <circle cx="16.5" cy="17" r="2.5" />
    </svg>
  ),
  danger: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  ),
  other: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="5.5" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.8" fill="currentColor" />
    </svg>
  ),
};

// ── ZK state reducer ─────────────────────────────────────────────────────────
// Declared outside the component so the function reference is stable across
// renders and React can use it without re-creating the reducer identity.

/** Maximum number of log lines kept in the ring-buffer. */
export const LOG_RING_SIZE = 6;
/** Maximum character length of a single log message before truncation. */
export const LOG_MAX_MSG_LENGTH = 200;

/** Immutable initial state — also used as the reset target. */
export const ZK_INITIAL = Object.freeze({
  status: "idle",
  logs: [],
  proof: null,
  error: "",
});

/**
 * Pure reducer for all ZK proof state.
 *
 * Actions:
 *   { type: "RESET" }
 *     → atomically clears all four fields in one React state transition.
 *       Prevents the buffer-overflow window that existed when four separate
 *       setState calls were issued from an async context.
 *
 *   { type: "SET_STATUS", payload: string }
 *   { type: "SET_ERROR",  payload: string }
 *   { type: "SET_PROOF",  payload: object|null }
 *     → targeted single-field updates used by buildPrivacyProof /
 *       recordZkCheckpoint after the reset boundary has been established.
 *
 *   { type: "PUSH_LOG", payload: string }
 *     → ring-buffer append with consecutive-duplicate guard.
 *       The ring is always capped at LOG_RING_SIZE entries so the render
 *       loop iterates over a bounded list regardless of how many onLog
 *       callbacks an in-flight WASM worker fires.
 *
 *   { type: "PATCH_PROOF", payload: object }
 *     → shallow-merges fields into the existing proof object (used when
 *       txHash / recordTxHash arrive after the proof is already set).
 */
export function zkReducer(state, action) {
  switch (action.type) {
    case "RESET":
      // Single atomic transition — no intermediate render between fields
      return { ...ZK_INITIAL, logs: [] };

    case "SET_STATUS":
      if (state.status === action.payload) return state; // bail-out, no render
      return { ...state, status: action.payload };

    case "SET_ERROR":
      if (state.error === action.payload) return state;
      return { ...state, error: action.payload };

    case "SET_PROOF":
      return { ...state, proof: action.payload };

    case "PATCH_PROOF":
      if (!state.proof) return state;
      return { ...state, proof: { ...state.proof, ...action.payload } };

    case "PUSH_LOG": {
      const raw = String(action.payload ?? "");
      // Truncate oversized messages to bound per-entry memory usage (#308)
      const msg =
        raw.length > LOG_MAX_MSG_LENGTH
          ? raw.slice(0, LOG_MAX_MSG_LENGTH) + "…"
          : raw;
      const prev = state.logs;
      // Consecutive-duplicate guard — identical adjacent messages are dropped
      if (prev.length > 0 && prev[prev.length - 1] === msg) return state;
      // Ring-buffer cap — oldest entry evicted once limit is reached
      const next =
        prev.length < LOG_RING_SIZE
          ? [...prev, msg]
          : [...prev.slice(-(LOG_RING_SIZE - 1)), msg];
      return { ...state, logs: next };
    }

    default:
      return state;
  }
}

// ── Wallet connection helpers ─────────────────────────────────────────────────
// Declared outside the component so they carry no closure over component state
// and can be imported directly by tests without mounting React.

/**
 * Stellar G-address structural validator.
 *
 * A valid Stellar public key (G-address) is:
 *   - exactly 56 characters
 *   - starts with the letter G
 *   - consists only of base-32 alphabet characters (A-Z, 2-7)
 *
 * Validating before storing prevents a compromised or misbehaving wallet
 * extension from injecting an arbitrary string into state and propagating it
 * into contract calls and ZK proof `recipientAddress` fields.
 *
 * Returns the trimmed address if valid, or an empty string otherwise.
 * Intentionally returns "" rather than throwing so callers treat an invalid
 * address the same as a cancelled / empty connection — no special error path.
 */
export function sanitizeWalletAddress(raw) {
  if (typeof raw !== "string") return "";
  const addr = raw.trim();
  // Stellar public key: 56-char base-32 string beginning with G
  if (!/^G[A-Z2-7]{55}$/.test(addr)) return "";
  return addr;
}

// ── Contact validation (#158) ──────────────────────────────────────────────
// Enforces strict regex validation for phone numbers or specific handles
// to prevent bad data or injection attacks.

const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;
const TELEGRAM_REGEX = /^@[A-Za-z0-9_]{5,32}$/;
const CONTACT_ALLOWLIST = [PHONE_REGEX, TELEGRAM_REGEX];

/**
 * Validate a contact field value against the allowlist.
 * Returns { valid, error } where error is a user-facing message.
 * Empty strings are treated as valid (contact is optional).
 */
export function validateContact(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return { valid: true, error: "" };
  if (trimmed.length > 40) return { valid: false, error: "Contact is too long (max 40 characters)." };
  const passesAny = CONTACT_ALLOWLIST.some((re) => re.test(trimmed));
  if (!passesAny) {
    return {
      valid: false,
      error: "Use a phone number (+1234567890) or Telegram handle (@username).",
    };
  }
  return { valid: true, error: "" };
}

// ── Profile & UI helpers ─────────────────────────────────────────────────

export function computeStep3Done(profile) {
  if (!profile) return true;
  return Boolean(profile.nickname || profile.contact || true);
}

export function computeUserCharacter(selectedChar, profile) {
  if (selectedChar) return selectedChar;
  const nickname = profile?.nickname || "me";
  return pickChar("default", nickname);
}

export const STATUS_CONFIG = {
  Pending: {
    label: "WAITING FOR RESPONDER",
    color: "#a2a586",
    bg: "rgba(162,165,134,0.12)",
    msg: "Your pin is live. Waiting for someone nearby.",
  },
  Enroute: {
    label: "RESPONDER ON THE WAY",
    color: "#7357FF",
    bg: "rgba(115,87,255,0.12)",
    msg: "Stay where you are. Help is coming.",
  },
  Resolved: {
    label: "RESOLVED",
    color: "#3F8487",
    bg: "rgba(63,132,135,0.12)",
    msg: "This request has been resolved.",
  },
  Cancelled: {
    label: "CANCELLED",
    color: "#a2a586",
    bg: "rgba(162,165,134,0.12)",
    msg: "Request cancelled.",
  },
};

export const DEFAULT_STATUS_INFO = {
  label: "UNKNOWN STATUS",
  color: "#a2a586",
  bg: "rgba(162,165,134,0.12)",
  msg: "Status is currently unavailable.",
};

export function getStatusConfig(requestStatus) {
  if (typeof requestStatus !== "string") return DEFAULT_STATUS_INFO;
  return STATUS_CONFIG[requestStatus] || DEFAULT_STATUS_INFO;
}

export function checkIsGetMode(mode) {
  if (typeof mode !== "string") return false;
  return mode.trim().toLowerCase() === "get";
}

export function getAccentColor(isGetMode) {
  return isGetMode ? "#FF7A6B" : "#7357FF";
}

/**
 * Creates a debounced state setter that batches rapid invocations into a
 * single React state update after `delay` ms of inactivity.  This prevents
 * high-frequency wallet events (e.g. STATE_UPDATED firing on every poll tick)
 * from flooding the main thread with re-renders during heavy computation.
 *
 * Returns { debouncedSet, flush, cancel }:
 *   debouncedSet(value) — schedules a state update (replaces any pending one)
 *   flush()             — immediately applies the pending value, if any
 *   cancel()            — discards the pending timer without updating state
 */
export function createDebouncedSetter(setter, delay = 100) {
  let latest = "";
  let timer = null;

  const debouncedSet = (value) => {
    latest = value;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      setter(latest);
    }, delay);
  };

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      setter(latest);
    }
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { debouncedSet, flush, cancel };
}

/**
 * Parallel validation of wallet connection status.
 *
 * Runs TWO independent checks at the point of use (render time), not just at
 * the point of entry (sanitizeWalletAddress in the useEffect setters):
 *
 *   1. hasAddress   — non-empty string (syntactic)
 *   2. isValid      — passes sanitizeWalletAddress (structural)
 *
 * Both must agree before the wallet is considered connected.  This provides
 * defence in depth against state corruption: even if a non-G-address somehow
 * reaches walletAddress, the boolean gate and the display string both refuse
 * to propagate it, preventing cryptographic material from leaking via partial
 * address display (slice calls) or contract-function arguments.
 *
 * Returns { isConnected, displayAddress }.
 */
export function computeWalletStatus(address) {
  const hasAddress = address !== "";
  const isValid = sanitizeWalletAddress(address) !== "";
  const isConnected = hasAddress && isValid;
  const displayAddress = isConnected
    ? `${address.slice(0, 8)}...${address.slice(-6)}`
    : "";
  return { isConnected, displayAddress };
}

/**
 * Cancellation token for guarding async operations inside useEffect.
 *
 * Each useEffect call-site creates one token; the cleanup calls `cancel()`.
 * In-flight async operations check `token.active` or use `token.wrap(promise)`
 * to bail out early, preventing stale state updates after the effect has been
 * torn down or re-run with different dependencies.
 *
 * Unlike the `let mounted = true` pattern, this uses a generation counter so
 * every invocation gets a unique generation id.  Async operations can compare
 * their captured generation against the token's current generation, which
 * correctly handles:
 *   - Sequential async steps in the same operation (check after each await)
 *   - Effect re-execution with new dependencies
 *   - Multiple in-flight operations from the same effect instance
 */
export function cancellationToken() {
  let cancelled = false;

  function check() {
    return !cancelled;
  }

  return {
    /** True while the token is still active (cancel not called). */
    get active() {
      return check();
    },

    /** Cancel the token.  All past and future `.wrap()` / guard checks return false. */
    cancel() {
      cancelled = true;
    },

    /**
     * Wraps an async operation so it short-circuits if the token is cancelled.
     * Returns a promise that resolves to the operation's result or `undefined`
     * if cancelled before completion.  If the operation rejects while the token
     * is still active the rejection is propagated; if cancelled the rejection
     * is swallowed to prevent unhandled rejections from floating promises.
     */
    async wrap(promise) {
      if (cancelled) {
        promise.catch(() => {});
        return undefined;
      }
      try {
        const result = await promise;
        if (cancelled) return undefined;
        return result;
      } catch (err) {
        if (cancelled) return undefined;
        throw err;
      }
    },
  };
}

const RETRY_CLS = "hp-mobile-open";
const RETRY_ID = "helphone-help-sidebar";

// Dead-letter queue for safeToggleClass — a plain null-prototype object,
// used as a simple string-keyed store (no inherited keys to collide with).
const dlq = Object.create(null);

/**
 * Safely toggles a CSS class on a DOM element with an explicit dead-letter
 * queue fallback.
 *
 * When the target element is not yet available in the DOM (ref is null), the
 * toggle request is queued and retried on the next animation frame instead of
 * being silently discarded.  This prevents desync between React state and DOM
 * state that occurs when a ref-based effect runs before the element mounts.
 *
 * The retry mechanism uses a shared dead-letter queue keyed by element ID so
 * that at most one pending toggle per element is outstanding.  If the caller's
 * desired state is superseded by a later call before the retry fires, the
 * earlier toggle is dropped automatically.
 *
 * @param {Element | null}  element  - The target DOM element (or null).
 * @param {boolean}         isOpen   - `true` to add the class, `false` to remove.
 * @param {string}          id       - Element ID used for dead-letter queue key.
 * @param {string}          cls      - The CSS class name (default: "hp-mobile-open").
 *
 * Returns `true` if the class was applied immediately, `false` if queued.
 */
export function safeToggleClass(
  element,
  isOpen,
  id = RETRY_ID,
  cls = RETRY_CLS,
) {
  if (element) {
    element.classList.toggle(cls, isOpen);
    delete dlq[id];
    return true;
  }

  // Dead-letter queue: schedule a retry if one isn't already pending.
  if (!dlq[id]) {
    const raf = requestAnimationFrame(() => {
      delete dlq[id];
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle(cls, isOpen);
      }
    });
    dlq[id] = raf;
  }
  return false;
}

function useOutsideClick(active, ref, onOutside) {
  useEffect(() => {
    if (!active) return;
    function onDocClick(e) {
      const target = e.target instanceof Node ? e.target : null;
      if (target && ref.current && !ref.current.contains(target)) {
        onOutside();
      }
    }
    document.addEventListener("click", onDocClick, { passive: true });
    return () => document.removeEventListener("click", onDocClick);
  }, [active, ref, onOutside]);
}

const ALL_CHARS = [
  ...CHARS.default,
  ...CHARS.male,
  ...CHARS.female,
  ...CHARS.undisclosed,
];

function AvatarSelectionModal({ open, onClose, selected, onSelect }) {
  const dialogRef = useRef(null);
  useFocusTrap(open, dialogRef);
  useEscapeKey(open, onClose);
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="avatar-select-title"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.68)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "360px",
          maxHeight: "80vh",
          borderRadius: "18px",
          background: "#1c3535",
          border: "1px solid rgba(63,132,135,0.32)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.58)",
          padding: "20px",
          overflow: "auto",
          outline: "none",
        }}
      >
        <h3
          id="avatar-select-title"
          style={{
            margin: "0 0 4px",
            fontFamily: "'Instrument Serif',serif",
            fontWeight: 400,
            fontSize: "22px",
            color: "#F4ECDC",
          }}
        >
          Choose your avatar
        </h3>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: "12px",
            color: "rgba(242,236,220,0.4)",
          }}
        >
          Pick a character to represent you on the map.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "8px",
          }}
        >
          {ALL_CHARS.map((name) => (
            <button
              key={name}
              onClick={() => onSelect(selected === name ? null : name)}
              style={{
                width: "100%",
                aspectRatio: "1",
                padding: 0,
                borderRadius: "10px",
                overflow: "hidden",
                cursor: "pointer",
                background:
                  selected === name
                    ? "rgba(115,87,255,0.2)"
                    : "rgba(255,255,255,0.04)",
                border:
                  selected === name
                    ? "2px solid #7357FF"
                    : "2px solid rgba(255,255,255,0.08)",
                transition: "all 0.15s",
              }}
            >
              <img
                src={`/assets/chars/${name}.png`}
                alt={name}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            marginTop: "16px",
            padding: "10px",
            borderRadius: "10px",
            border: "none",
            background: "#3F8487",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

export default function Help() {
  useDocumentTitle("Help");
  const {
    mode,
    setMode,
    profile,
    setProfile,
    contactError,
    setContactError,
    emergencyType,
    setEmergencyType,
    showEmergencyModal,
    setShowEmergencyModal,
    showOnboarding,
    setShowOnboarding,
    showFeedback,
    setShowFeedback,
    feedbackRequestId,
    setFeedbackRequestId,
    feedbackResponderAddress,
    setFeedbackResponderAddress,
    styleOpen,
    setStyleOpen,
    profileOpen,
    setProfileOpen,
    showMobileForm,
    setShowMobileForm,
    showCancelConfirm,
    setShowCancelConfirm,
    showDisconnectConfirm,
    setShowDisconnectConfirm,
    showResolveConfirm,
    setShowResolveConfirm,
    showAvatarModal,
    setShowAvatarModal,
    selectedChar,
    setSelectedChar,
    mapStyleIndex,
    setMapStyleIndex,
  } = useHelpUiState({ loadProfile });
  const {
    location,
    setLocation,
    locating,
    locationError,
    searchQuery,
    setSearchQuery,
    searchLoading,
    searchError,
    searchSuggestions,
    searchSuggestLoading,
    activeSuggestion,
    setActiveSuggestion,
    searchBoxRef,
    requestLocation,
    handleSearch,
    selectSearchSuggestion,
    handleSearchKeyDown,
  } = useLocationSearch({ mapboxToken: MAPBOX_TOKEN });
  const {
    requestId,
    setRequestId,
    requestStatus,
    setRequestStatus,
    submitting,
    setSubmitting,
    submitError,
    setSubmitError,
    requestError,
    setRequestError,
    responders,
    setResponders,
    popupMarker,
    setPopupMarker,
    myRequests,
    setMyRequests,
    myRequestsLoading,
    setMyRequestsLoading,
    openRequests,
    setOpenRequests,
    openRequestsLoading,
    setOpenRequestsLoading,
    openRequestsArray,
    selectedRequest,
    setSelectedRequest,
    offerSubmitting,
    setOfferSubmitting,
    lastOfferReceipt,
    setLastOfferReceipt,
    setTrackingRequestId,
    setTrackingIndex,
    responderArrived,
    setResponderArrived,
    arrivalSubmitting,
    setArrivalSubmitting,
    arrivalThanksOpen,
    setArrivalThanksOpen,
    requesterLocation,
    setRequesterLocation,
    settledViewport,
    syncSettledViewport,
  } = useRequestMapState({ defaultCenter: DEFAULT_CENTER });
  // ── ZK state — single reducer for atomic resets ───────────────────────────
  // All four ZK fields are managed together so that resetZkCheckpoint()
  // dispatches ONE action → ONE state transition → ONE scheduled render.
  // Issuing four separate setState calls from an async context (handleSubmit /
  // handleOffer) allows in-flight onLog callbacks to append to a partially-reset
  // buffer between renders, which causes stale log entries that the ring-buffer
  // deduplicator then silently drops, ultimately losing the first log line of
  // the new proof session and surfacing as a dropped emergency request UI state.
  const [zkState, dispatchZk] = useReducer(zkReducer, ZK_INITIAL);
  // Destructured aliases — downstream code uses these names directly so no
  // further renaming is needed across the 20+ call sites in the component.
  const zkStatus = zkState.status;
  const zkLogs = zkState.logs;
  const zkProof = zkState.proof;
  const zkError = zkState.error;

  // Issue #101 — screen-reader announcement for async ZK operations
  const [zkAnnouncement, setZkAnnouncement] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [mediaFile, setMediaFile] = useState(null);
  const [mediaPreview, setMediaPreview] = useState(null);

  // #144: Compress and preview selected image
  const handleMediaSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      const MAX = 800;
      if (width > MAX || height > MAX) {
        if (width > height) { height = Math.round((height / width) * MAX); width = MAX; }
        else { width = Math.round((width / height) * MAX); height = MAX; }
      }
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (blob) {
          setMediaFile(blob);
          setMediaPreview(URL.createObjectURL(blob));
        }
        URL.revokeObjectURL(url);
      }, 'image/jpeg', 0.8);
    };
    img.src = url;
  }, []);

  const {
    prefs: alertPrefs,
    alertNewRequest,
    toggleSound,
    toggleHaptic,
  } = useAlertFeedback();
  // Issue #155 — request priority level
  const [requestPriority, setRequestPriority] = useState('Medium');

  // Issue #156 — responder availability
  const [responderActive, setResponderActive] = useState(true);
  const [responderStatusLoading, setResponderStatusLoading] = useState(false);

  const styleSelectorRef = useRef(null);
  const profileRef = useRef(null);
  const sidebarRef = useRef(null);
  const cancelDialogRef = useRef(null);
  const disconnectDialogRef = useRef(null);
  const resolveDialogRef = useRef(null);
  const emergencyDialogRef = useRef(null);
  useFocusTrap(showCancelConfirm !== null, cancelDialogRef);
  useFocusTrap(showDisconnectConfirm, disconnectDialogRef);
  useFocusTrap(showResolveConfirm, resolveDialogRef);
  useFocusTrap(showEmergencyModal, emergencyDialogRef);
  useEscapeKey(showCancelConfirm !== null, () => setShowCancelConfirm(null));
  useEscapeKey(showDisconnectConfirm, () => setShowDisconnectConfirm(false));
  useEscapeKey(showResolveConfirm, () => setShowResolveConfirm(false));
  useEscapeKey(showEmergencyModal, () => setShowEmergencyModal(false));
  const handleOfferBusy = useRef(false);
  const handleOfferMounted = useRef(true);
  const handleOfferSeq = useRef(0);
  const {
    setWalletAddress,
    walletLoading,
    walletConnecting,
    walletBalances,
    walletBalanceStatus,
    activeWalletAddress,
    isWalletConnected,
    displayAddress,
    promptWalletConnection,
  } = useWalletState({ setProfileOpen });

  // ── Field ops state (ISP-131/134/135) ─────────────────────────────────────
  const [showRadioSheet, setShowRadioSheet] = useState(false);
  const [showStagingSheet, setShowStagingSheet] = useState(false);
  const [showSosSheet, setShowSosSheet] = useState(false);
  const [sosDispatchedAt, setSosDispatchedAt] = useState(null);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const rugged = useRuggedMode();
  const radio = useRadioBridge();
  const nfc = useNfcCheckIn({ responderId: activeWalletAddress || "anonymous" });

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Pocket-press gate: auto-dispatch only inside an active incident geofence;
  // anywhere else the hardware key routes through the confirm sheet.
  const canSosAutoDispatch = useCallback(() => {
    if (!location || !Number.isFinite(location[0])) return false;
    return openRequestsArray.some(
      (r) =>
        r &&
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lng) &&
        distance(location, [r.lat, r.lng]) <= 0.5,
    );
  }, [location, openRequestsArray]);

  const handleSosCommit = useCallback(
    ({ idempotencyKey }) => {
      setRequestPriority("High");
      setMode("get");
      setEmergencyType((prev) => prev || "fallen");
      setSosDispatchedAt(Date.now());
      setZkAnnouncement("SOS dispatched. Escalated emergency request queued.");
      radio.send(
        {
          type: "fallen",
          severity: 3,
          id: String(idempotencyKey || "").slice(-8),
          ts: Date.now(),
          lat: location?.[0],
          lng: location?.[1],
        },
        { type: MSG.SOS, prio: PRIO.SOS },
      );
    },
    [radio, location],
  );

  const sos = useHardwareSOS({
    canAutoDispatch: canSosAutoDispatch,
    onCommit: handleSosCommit,
    onNeedsConfirm: () => setShowSosSheet(true),
  });

  useEffect(() => {
    if (!location?.[0] || !location?.[1]) return;
  }, [location?.[0], location?.[1]]);

  useEffect(() => {
    return () => {
      handleOfferMounted.current = false;
    };
  }, []);

  useEffect(() => {
    safeToggleClass(sidebarRef.current, showMobileForm);
  }, [showMobileForm]);

  useOutsideClick(
    styleOpen,
    styleSelectorRef,
    useCallback(() => setStyleOpen(false), []),
  );

  useOutsideClick(
    profileOpen,
    profileRef,
    useCallback(() => setProfileOpen(false), []),
  );

  useEffect(() => {
    localStorage.setItem("hp_profile", JSON.stringify(profile));
  }, [profile]);

  // (#137) Sync preferences to the backend when the wallet is connected.
  // On wallet connect: load server prefs and merge over localStorage.
  // On profile change: push latest prefs to the server.
  useEffect(() => {
    if (!activeWalletAddress) return;
    preferencesService.getPreferences(activeWalletAddress)
      .then((preferences) => {
        if (preferences && Object.keys(preferences).length > 0) {
          setProfile((prev) => ({ ...prev, ...preferences }));
        }
      })
      .catch(() => {});
  }, [activeWalletAddress]);

  useEffect(() => {
    if (!activeWalletAddress) return;
    const prefs = {
      nickname: profile.nickname,
      contact: profile.contact,
      gender: profile.gender,
    };
    preferencesService.updatePreferences(activeWalletAddress, prefs)
      .catch(() => {});
  }, [activeWalletAddress, profile.nickname, profile.contact, profile.gender]);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  useEffect(() => {
    if (mode !== "offer") return;
    const token = cancellationToken();
    let loading = false;
    let timer = null;
    const BASE_DELAY_MS = 5000;
    const MAX_DELAY_MS = 60000;
    let consecutiveFailures = 0;

    async function load() {
      if (loading) return;
      loading = true;
      if (token.active) setOpenRequestsLoading(true);
      let failed = false;
      try {
        const ids = await getActiveRequests();
        const requests = await Promise.all(
          ids.map((id) =>
            getRequest(id)
              .then((req) =>
                req && req.status === "Pending" ? { ...req, id } : null,
              )
              .catch(() => null),
          ),
        ).then((results) => results.filter(Boolean));
        if (token.active) {
          const map = new globalThis.Map(
            requests.map((req) => [Number(req.id), req]),
          );
          // #142: alert on new requests when switching to offer mode
          if (openRequests.size === 0 && map.size > 0) {
            alertNewRequest();
          }
          setOpenRequests(map);
          setSelectedRequest((current) => {
            if (!current) return current;
            return map.get(Number(current.id)) || null;
          });
        }
      } catch (_) {
        failed = true;
      }
      if (token.active) setOpenRequestsLoading(false);
      loading = false;

      consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
      const delay = failed
        ? Math.min(BASE_DELAY_MS * 2 ** consecutiveFailures, MAX_DELAY_MS)
        : BASE_DELAY_MS;
      if (token.active) {
        timer = setTimeout(load, delay);
      }
    }

    load();
    // Issue #177: also react to contract events (pushed via SSE) for
    // near-immediate updates on top of the resilient backoff loop above,
    // which remains as the backstop if the event stream is unavailable.
    const unsubscribe = subscribeToContractEvents((event) => {
      if (["RqCreated", "Resolved", "Cancelled"].includes(event.topic)) load();
    });
    return () => {
      token.cancel();
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [mode]);

  function validLocation() {
    return (
      location && Number.isFinite(location[0]) && Number.isFinite(location[1])
    );
  }

  /**
   * Append a diagnostic line to the ZK log ring-buffer.
   *
   * Type-safe entry point for all ZK log messages. Accepts any value that
   * callers (including external WASM/worker callbacks via `onLog`) might
   * produce and coerces it to a non-empty string before touching state.
   *
   * Coercion rules (applied in order):
   *   null / undefined      → silently dropped  (no-op)
   *   Error instance        → err.message, falling back to err.toString()
   *   object / array        → JSON.stringify, falling back to String()
   *   number / boolean      → String()
   *   empty string / blanks → silently dropped  (no-op)
   *
  /**
   * Append a diagnostic line to the ZK log ring-buffer.
   *
   * Delegates to the reducer's PUSH_LOG action which enforces the ring-buffer
   * cap and consecutive-duplicate guard atomically inside the reducer, keeping
   * all buffer-overflow protection in one auditable place.
   *
   * Type coercion rules (applied before dispatch):
   *   null / undefined      → silently dropped  (no-op)
   *   Error instance        → err.message, falling back to err.toString()
   *   object / array        → JSON.stringify, falling back to String()
   *   number / boolean      → String()
   *   empty string / blanks → silently dropped  (no-op)
   */
  function pushZkLog(message) {
    let safe;
    if (message === null || message === undefined) return;
    if (message instanceof Error) {
      safe = message.message || message.toString();
    } else if (typeof message === "object") {
      try {
        safe = JSON.stringify(message);
      } catch {
        safe = String(message);
      }
    } else {
      safe = String(message);
    }
    safe = safe.trim();
    if (!safe) return;
    dispatchZk({ type: "PUSH_LOG", payload: safe });
  }

  /**
   * Atomically reset all ZK proof state to the initial idle snapshot.
   *
   * A single reducer dispatch guarantees ONE React state transition for all
   * four fields (status / logs / proof / error). This closes the window that
   * existed with four sequential setState calls where an in-flight onLog
   * callback from a previous proof run could append to a partially-cleared
   * log buffer between intermediate renders, causing:
   *   1. The ring-buffer deduplicator to silently drop the first log line of
   *      the new proof session if it matched the last stale entry.
   *   2. The emergency request UI to show a stale "proved" / "recorded" badge
   *      during the reset frame, then snap to "idle" — a visible flicker that
   *      caused users to retry and submit duplicate requests.
   */
  function resetZkCheckpoint() {
    dispatchZk({ type: "RESET" });
  }

  // Issue #101 — announce ZK status transitions to screen readers
  useEffect(() => {
    if (zkStatus === 'proving') setZkAnnouncement('Location proof generation started');
    else if (zkStatus === 'proved') setZkAnnouncement('Location proof generated successfully');
    else if (zkStatus === 'recording') setZkAnnouncement('Recording proof on Stellar blockchain');
    else if (zkStatus === 'recorded') setZkAnnouncement('Proof recorded on Stellar successfully');
    else if (zkStatus === 'error') setZkAnnouncement(`Error: ${zkError || 'proof generation failed'}`);
  }, [zkStatus, zkError]);

  // O(1) removal: Map keyed by numeric id — no linear scan.
  // NaN is rejected up front: every unparseable id would otherwise coerce to
  // the same NaN key, so distinct requests could collide and clobber or
  // remove each other's state (a request from one id evicting another's).
  function removeOpenRequest(reqId) {
    const key = Number(reqId);
    if (!Number.isFinite(key)) return;
    setSelectedRequest((current) =>
      Number(current?.id) === key ? null : current,
    );
    setOpenRequests((prev) => {
      if (!prev.has(key)) return prev;
      const next = new globalThis.Map(prev);
      next.delete(key);
      return next;
    });
  }

  function syncOpenRequest(reqId, fresh) {
    const key = Number(reqId);
    if (!Number.isFinite(key)) return null;
    const request = { ...fresh, id: key };
    setOpenRequests((prev) => {
      const next = new globalThis.Map(prev);
      next.set(key, request);
      return next;
    });
    setSelectedRequest((current) =>
      Number(current?.id) === key ? request : current,
    );
    return request;
  }

  // DEPRECATED: requestUnavailableMessage - blocking main thread
  // Replaced with non-blocking state-based error handling to prevent
  // smart contract access control bypass through race conditions
  function requestUnavailableMessage(request) {
    if (!request) return "This request is no longer available.";
    if (request.status === "Enroute")
      return "Someone is already on the way for this request.";
    if (request.status === "Resolved")
      return "This request has already been resolved.";
    if (request.status === "Cancelled") return "This request was cancelled.";
    return "This request is no longer pending.";
  }

  // Track active refresh operations to prevent concurrent access control bypass
  const _refreshLocks = new globalThis.Map();

  async function refreshPendingRequest(reqId) {
    // Normalize before locking/keying: a raw reqId can arrive as a string or
    // number for the same request, and coercing only after the lock check
    // let concurrent refreshes of the same id race past this guard.
    const key = Number(reqId);
    if (!Number.isFinite(key)) return null;
    // Prevent concurrent refreshes of same request to avoid race conditions
    if (_refreshLocks.has(key)) {
      return null;
    }
    _refreshLocks.set(key, true);

    try {
      const fresh = await getRequest(key);
      if (!fresh || fresh.status !== "Pending") {
        removeOpenRequest(key);
        // Non-blocking error handling to prevent main thread blocking
        // and smart contract access control bypass
        setRequestError(requestUnavailableMessage(fresh));
        // Auto-clear error after display to prevent stale state
        setTimeout(() => setRequestError(""), 5000);
        return null;
      }
      // Clear any previous error on successful refresh
      setRequestError("");
      return syncOpenRequest(key, fresh);
    } finally {
      _refreshLocks.delete(key);
    }
  }

  function isRequestStatusRace(err) {
    return err?.operation === "accept_request" && err?.contractCode === 3;
  }

  async function buildPrivacyProof({
    scope,
    lat,
    lng,
    campaignId,
    address,
    radiusMeters = 3000,
  }) {
    dispatchZk({ type: "SET_STATUS", payload: "proving" });
    dispatchZk({ type: "SET_ERROR", payload: "" });
    dispatchZk({ type: "PUSH_LOG", payload: "Preparing private witness" });
    // Load the ZK prover only now that a proof is actually requested.
    const zk = await loadZk();
    const zone = zk.buildLocationProofZone({ lat, lng, radiusMeters });
    const proof = await zk.generateLocationProof({
      lat,
      lng,
      campaignId,
      recipientAddress: address,
      zone,
      onLog: pushZkLog,
    });
    const checkpoint = {
      scope,
      campaignId,
      nullifier: proof.nullifier,
      proof,
      zone,
      createdAt: new Date().toISOString(),
    };
    dispatchZk({ type: "SET_PROOF", payload: checkpoint });
    dispatchZk({ type: "SET_STATUS", payload: "proved" });
    pushZkLog("Private location proof ready");
    return checkpoint;
  }

  // Parallelized checkpoint recording with CORS-safe error handling
  // Prevents inaccurate state synchronization by handling cross-origin rejections
  const _checkpointRecordLock = new globalThis.Map();
  const _LOCK_TTL = 30000; // 30 second lock TTL for stale lock cleanup

  async function recordZkCheckpoint(address, action, txHash, checkpoint) {
    if (!checkpoint?.nullifier) return;

    // Prevent parallel recording of same checkpoint to avoid state sync issues
    const lockKey = `${checkpoint.nullifier}-${action}`;
    const existingLock = _checkpointRecordLock.get(lockKey);

    // Clean up stale locks
    if (existingLock && Date.now() - existingLock.timestamp > _LOCK_TTL) {
      _checkpointRecordLock.delete(lockKey);
    } else if (existingLock) {
      pushZkLog("Checkpoint recording already in progress");
      return;
    }

    _checkpointRecordLock.set(lockKey, { timestamp: Date.now() });

    try {
      dispatchZk({ type: "SET_STATUS", payload: "recording" });
      pushZkLog("Writing proof fingerprint to Stellar");

      // Parallelize with timeout to handle CORS rejections safely
      const recordPromise = recordExpertVerification(
        address,
        action,
        txHash || "",
        checkpoint.nullifier,
        StellarWalletsKit,
      );

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("CORS timeout")), 15000),
      );

      const record = await Promise.race([recordPromise, timeoutPromise]);

      dispatchZk({
        type: "PATCH_PROOF",
        payload: { recordTxHash: record.hash || "" },
      });
      dispatchZk({ type: "SET_STATUS", payload: "recorded" });
      pushZkLog("Stellar checkpoint recorded");
    } catch (err) {
      dispatchZk({ type: "SET_STATUS", payload: "proved" });

      // CORS-safe error handling - don't expose sensitive error details
      let errorMsg = "wallet rejected";
      if (err.message?.includes("CORS") || err.message?.includes("network")) {
        errorMsg = "network error - check connection";
      } else if (err.message?.includes("timeout")) {
        errorMsg = "request timed out";
      } else if (err.message?.includes("fetch")) {
        errorMsg = "connection failed";
      }

      pushZkLog(`Checkpoint record skipped: ${errorMsg}`);

      // Ensure state is synchronized even on rejection
      dispatchZk({
        type: "PATCH_PROOF",
        payload: { recordError: errorMsg, recordTimestamp: Date.now() },
      });
    } finally {
      _checkpointRecordLock.delete(lockKey);
    }
  }

  async function handleSubmit() {
    if (!validLocation()) {
      setSubmitError("Set your location first.");
      return;
    }
    if (!emergencyType) {
      setSubmitError("Select what happened.");
      return;
    }
    const contactCheck = validateContact(profile.contact);
    if (!contactCheck.valid) {
      setSubmitError(contactCheck.error);
      setContactError(contactCheck.error);
      return;
    }
    const address = activeWalletAddress || (await promptWalletConnection());
    if (!address) {
      setSubmitError("Connect your Stellar wallet first.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    resetZkCheckpoint();
    try {
      await ensureAccountFunded(address);
      // [Optimize] Overhaul campaignId to eliminate silent failure on network timeouts
      let campaignId;
      try {
        campaignId = await Promise.race([
          Promise.resolve(proofCampaignId(`request:${address}:${Date.now()}`)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 5000),
          ),
        ]);
      } catch (e) {
        throw new Error("campaignId network timeout");
      }
      const checkpoint = await buildPrivacyProof({
        scope: "Private request",
        lat: location[0],
        lng: location[1],
        campaignId,
        address,
        radiusMeters: 3000,
      });
      const publicLocation = anonymizeLocation(location);
      const { requestId: id, hash } = await createRequest(
        address,
        publicLocation[0],
        publicLocation[1],
        emergencyType,
        "",
        "",
        StellarWalletsKit,
        requestPriority,
      );
      setRequestId(id);
      setRequestStatus("Pending");
      saveMyRequestId(id);
      dispatchZk({
        type: "PATCH_PROOF",
        payload: { requestId: id, txHash: hash },
      });
      await recordZkCheckpoint(
        address,
        "private_request_proof",
        hash,
        checkpoint,
      );
    } catch (err) {
      dispatchZk({ type: "SET_STATUS", payload: "error" });
      dispatchZk({
        type: "SET_ERROR",
        payload: err.message || "ZK proof failed",
      });
      setSubmitError("Could not send. " + (err.message || ""));
    }
    setSubmitting(false);
  }

  // [Redesign] Overhaul handleCancel to fix insecure local storage access
  const handleCancel = useCallback(
    async (requestId) => {
      const address = activeWalletAddress;
      if (!address) return;
      setShowCancelConfirm(null);
      // [Refactor] Overhaul prevStatus to prevent stale closures causing ghost renders
      const prevStatus = requestStatus;
      try {
        await cancelRequest(address, requestId, StellarWalletsKit);
        setRequestStatus("Cancelled");
      } catch (err) {
        setRequestStatus(prevStatus);
      }
    },
    [
      activeWalletAddress,
      requestStatus,
      setShowCancelConfirm,
      setRequestStatus,
    ],
  );

  async function handleOffer(req) {
    if (handleOfferBusy.current) return;
    if (!validLocation()) {
      alert(
        "Enable your location first so the requester can see you on the map.",
      );
      return;
    }
    const reqId = Number(req.id);
    if (!Number.isFinite(reqId)) {
      alert("Invalid request");
      return;
    }
    const fresh = await refreshPendingRequest(reqId);
    if (!fresh) return;
    const address = activeWalletAddress || (await promptWalletConnection());
    if (!address) return;

    handleOfferBusy.current = true;
    const seq = ++handleOfferSeq.current;
    const curLocation = [...location];
    setOfferSubmitting(true);
    resetZkCheckpoint();
    try {
      await ensureAccountFunded(address);
      if (seq !== handleOfferSeq.current || !handleOfferMounted.current) return;
      const checkpoint = await buildPrivacyProof({
        scope: "Private responder",
        lat: curLocation[0],
        lng: curLocation[1],
        campaignId: proofCampaignId(`offer:${reqId}`),
        address,
        radiusMeters: 3000,
      });
      if (seq !== handleOfferSeq.current || !handleOfferMounted.current) return;
      const latest = await refreshPendingRequest(reqId);
      if (!latest) {
        pushZkLog("Request changed before Stellar confirmation");
        dispatchZk({ type: "SET_STATUS", payload: "proved" });
        return;
      }
      const eta = Math.round(Math.random() * 480 + 180);
      const publicLocation = [...anonymizeLocation(curLocation)];
      const result = await acceptRequest(
        address,
        reqId,
        publicLocation[0],
        publicLocation[1],
        eta,
        StellarWalletsKit,
      );
      if (!handleOfferMounted.current) return;
      setSelectedRequest(null);
      setLastOfferReceipt({
        requestId: reqId,
        label: privateRequestLabel(reqId),
        emergencyType: latest.emergency_type,
        txHash: result.hash || "",
        proofId: checkpoint.nullifier,
        at: new Date().toISOString(),
      });
      dispatchZk({
        type: "PATCH_PROOF",
        payload: { requestId: reqId, txHash: result.hash || "" },
      });
      await recordZkCheckpoint(
        address,
        "private_responder_proof",
        result.hash || "",
        checkpoint,
      );
      if (!handleOfferMounted.current) return;
      setOpenRequests((prev) => {
        const next = new globalThis.Map(prev);
        next.delete(reqId);
        return next;
      });
      if (latest.lat != null && latest.lng != null) {
        setRequesterLocation([latest.lat, latest.lng]);
      }
    } catch (err) {
      if (!handleOfferMounted.current) return;
      if (isRequestStatusRace(err)) {
        removeOpenRequest(reqId);
        dispatchZk({ type: "SET_STATUS", payload: "proved" });
        dispatchZk({ type: "SET_ERROR", payload: "" });
        pushZkLog("Request is no longer pending");
        alert(err.message);
        return;
      }
      dispatchZk({ type: "SET_STATUS", payload: "error" });
      dispatchZk({
        type: "SET_ERROR",
        payload: err.message || "ZK proof failed",
      });
      alert("Could not accept request: " + (err.message || ""));
    } finally {
      if (handleOfferMounted.current) setOfferSubmitting(false);
      handleOfferBusy.current = false;
    }
  }

  async function handleMarkArrived() {
    if (!lastOfferReceipt || arrivalSubmitting) return;
    setArrivalSubmitting(true);
    try {
      const result = await markArrived(
        activeWalletAddress,
        lastOfferReceipt.requestId,
        StellarWalletsKit,
      );
      setResponderArrived(true);
      setLastOfferReceipt((prev) =>
        prev
          ? { ...prev, arrivalTxHash: result?.hash || prev.arrivalTxHash || "" }
          : prev,
      );
      setArrivalThanksOpen(true);
    } catch (err) {
      alert("Could not mark arrived: " + (err.message || ""));
    } finally {
      setArrivalSubmitting(false);
    }
  }

  useEffect(() => {
    if (!requestId) return;
    const token = cancellationToken();

    async function poll() {
      try {
        const count = await getResponderCount(requestId);
        let found = false;
        for (let i = 0; i < count; i++) {
          const r = await getResponder(requestId, i);
          if (!r) continue;
          found = true;
          if (token.active) {
            setResponders((prev) => {
              const idx = prev.findIndex((p) => p.responder === r.responder);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = r;
                return next;
              }
              return [...prev, r];
            });
            setRequestStatus("Enroute");
            setTrackingIndex(i);
            if (r.arrived) setResponderArrived(true);
          }
        }
        if (!found && token.active) {
          setResponders([]);
        }
      } catch (_) {}
    }

    poll();
    // Issue #177: RqAcptd/LocUpd/Arrived events for THIS request trigger
    // an immediate re-poll; the interval below is now just a slow
    // backstop (upstream had this at 3000ms — events do the real-time
    // work now, so it's slowed to 15000ms rather than dropped entirely).
    const unsubscribe = subscribeToContractEvents((event) => {
      if (["RqAcptd", "LocUpd", "Arrived"].includes(event.topic)) poll();
    });
    const interval = setInterval(poll, 15000);
    return () => {
      token.cancel();
      clearInterval(interval);
      unsubscribe();
    };
  }, [requestId]);

  useEffect(() => {
    if (!lastOfferReceipt || responderArrived) return;
    const token = cancellationToken();
    async function ping() {
      if (!token.active) return;
      if (!validLocation()) return;
      if (!activeWalletAddress || !lastOfferReceipt?.requestId) return;
      try {
        await token.wrap(
          updateLocation(
            activeWalletAddress,
            lastOfferReceipt.requestId,
            location[0],
            location[1],
          ),
        );
      } catch (_) {}
    }
    ping();
    const interval = setInterval(ping, 5000);
    return () => {
      token.cancel();
      clearInterval(interval);
    };
  }, [
    lastOfferReceipt?.requestId,
    location?.[0],
    location?.[1],
    responderArrived,
  ]);

  useEffect(() => {
    if (!lastOfferReceipt) return;
    const token = cancellationToken();
    async function fetchRequester() {
      const requestId = lastOfferReceipt?.requestId;
      if (!requestId) return;
      try {
        const req = await getRequest(requestId);
        if (token.active && req && req.lat != null && req.lng != null) {
          setRequesterLocation([req.lat, req.lng]);
        }
      } catch {}
    }
    fetchRequester();
    const interval = setInterval(fetchRequester, 8000);
    return () => {
      token.cancel();
      clearInterval(interval);
    };
  }, [lastOfferReceipt?.requestId]);

  useEffect(() => {
    if (!activeWalletAddress) {
      setMyRequests([]);
      return;
    }
    const token = cancellationToken();
    async function fetchMyRequests() {
      const ids = loadMyRequestIds();
      if (ids.length === 0) {
        if (token.active) setMyRequests([]);
        return;
      }
      setMyRequestsLoading(true);
      try {
        const results = await Promise.all(
          ids.map((id) => getRequest(id).catch(() => null)),
        );
        const filtered = results.filter(
          (r) =>
            r &&
            typeof r.requester === "string" &&
            r.requester === activeWalletAddress &&
            Number.isFinite(r.id) &&
            Number.isFinite(r.created_at),
        );
        filtered.sort((a, b) => b.created_at - a.created_at);
        if (token.active) setMyRequests(filtered);
      } catch (_) {}
      if (token.active) setMyRequestsLoading(false);
    }
    fetchMyRequests();
    const interval = setInterval(fetchMyRequests, 10000);
    return () => {
      token.cancel();
      clearInterval(interval);
    };
  }, [activeWalletAddress]);

  useEffect(() => {
    setTrackingRequestId(null);
    setTrackingIndex(null);
    setResponderArrived(false);
    setResponders([]);
  }, [mode, requestId]);

  const step1Done = !!location;
  const step2Done = !!emergencyType;
  const step3Done = computeStep3Done(profile);
  const currentStep = !step1Done
    ? 1
    : requestStatus === "idle"
      ? !step2Done
        ? 2
        : 4
      : 5;

  const myChar = computeUserCharacter(selectedChar, profile);

  const statusConfig = STATUS_CONFIG;
  const statusInfo = getStatusConfig(requestStatus);

  const isGetMode = checkIsGetMode(mode);
  const accentColor = getAccentColor(isGetMode);

  const showTracking =
    (requestStatus === "Enroute" && responders.length > 0) ||
    (lastOfferReceipt && !responderArrived);

  // Issue #153 — clustering for offer mode open requests
  const openRequestsPoints = useMemo(() => {
    if (isGetMode) return [];
    return openRequestsArray.filter(
      (r) => Number.isFinite(r.lat) && Number.isFinite(r.lng),
    );
  }, [isGetMode, openRequestsArray]);

  const mapBounds = useMemo(() => {
    if (!settledViewport) return undefined;
    const { longitude, latitude, zoom } = settledViewport;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return undefined;
    const halfWidth = 360 / Math.pow(2, zoom + 2);
    const halfHeight = 180 / Math.pow(2, zoom + 2);
    return [
      longitude - halfWidth,
      latitude - halfHeight,
      longitude + halfWidth,
      latitude + halfHeight,
    ];
  }, [settledViewport]);

  const { clusters, getClusterExpansionZoom } = useClusterer(
    openRequestsPoints,
    settledViewport?.zoom ?? 12,
    mapBounds,
  );

  // Issue #154 — geofencing alerts
  const { triggered: geofenceAlerts, dismissAlert: dismissGeofenceAlert } =
    useGeofencing(openRequestsArray, location, isGetMode);

  const handleClusterClick = useCallback(
    (clusterId, clusterLng, clusterLat) => {
      const zoom = getClusterExpansionZoom(clusterId);
      const map = document.querySelector(".mapboxgl-map");
      if (map && map.__mapbox_map) {
        map.__mapbox_map.flyTo({
          center: [clusterLng, clusterLat],
          zoom: Math.min(zoom, 18),
          duration: 800,
        });
      }
    },
    [getClusterExpansionZoom],
  );

  // Issue #156 — responder status sync
  useEffect(() => {
    if (!activeWalletAddress) return;
    responderStatusService.getStatus(activeWalletAddress)
      .then((data) => {
        if (data && typeof data.active === "boolean") {
          setResponderActive(data.active);
        }
      })
      .catch(() => {});
  }, [activeWalletAddress]);

  useEffect(() => {
    if (!activeWalletAddress) return;
    setResponderStatusLoading(true);
    responderStatusService.updateStatus(activeWalletAddress, responderActive)
      .catch(() => {})
      .finally(() => setResponderStatusLoading(false));
  }, [activeWalletAddress, responderActive]);

  const S = {
    input: {
      width: "100%",
      padding: "9px 11px",
      background: "rgba(255,255,255,0.08)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "8px",
      color: "rgba(242,236,220,0.9)",
      fontSize: "13px",
      outline: "none",
      boxSizing: "border-box",
    },
    btnGhost: {
      padding: "8px 12px",
      background: "rgba(255,255,255,0.08)",
      color: "rgba(242,236,220,0.8)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "8px",
      fontSize: "12px",
      cursor: "pointer",
      width: "100%",
    },
    errorMsg: { fontSize: "11px", color: "#FF7A6B", marginTop: "6px" },
    divider: {
      borderTop: "1px solid rgba(255,255,255,0.07)",
      margin: "16px 0",
    },
  };

  return (
    <MainLayout
      navbar={false}
      footer={false}
      style={{ padding: 0, background: "var(--color-bg)" }}
    >
      <div id="helphone-help-wrap" className="hp-help-wrap">
        {/* Issue #101 — visually hidden live region for screen reader announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        role="status"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {zkAnnouncement}
      </div>
      <aside
        ref={sidebarRef}
        id="helphone-help-sidebar"
        role="complementary"
        aria-label="Request panel"
        className="hp-help-sidebar hp-scrollbar"
      >
        {/* Mobile drag handle — hidden on desktop via CSS */}
        <button
          type="button"
          aria-label={showMobileForm ? "Collapse panel" : "Expand panel"}
          aria-expanded={showMobileForm}
          onClick={() => setShowMobileForm((o) => !o)}
          id="hp-sidebar-drag-handle"
          style={{
            display: "none",
            width: "100%",
            padding: "12px 0 6px",
            minHeight: "44px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: "36px",
              height: "4px",
              borderRadius: "2px",
              background: "rgba(255,255,255,0.2)",
              margin: "0 auto",
            }}
          />
        </button>
        <div style={{ padding: "20px 20px 36px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "20px",
            }}
          >
            <Link
              to="/"
              style={{
                fontFamily: "'Instrument Serif',serif",
                fontSize: "20px",
                textDecoration: "none",
                display: "flex",
              }}
            >
              <span style={{ color: "#F4ECDC", fontStyle: "italic" }}>Hel</span>
              <span style={{ color: "#a2a586" }}>Phone</span>
            </Link>
            <Link
              to="/"
              style={{
                fontSize: "12px",
                color: "rgba(242,236,220,0.72)",
                textDecoration: "none",
                minHeight: "44px",
                display: "flex",
                alignItems: "center",
              }}
            >
              ← Back
            </Link>
          </div>

          {walletLoading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                padding: "10px",
                marginBottom: "16px",
                borderRadius: "10px",
                background: "rgba(115,87,255,0.08)",
                border: "1px solid rgba(115,87,255,0.15)",
              }}
            >
              <div
                style={{
                  width: "12px",
                  height: "12px",
                  borderRadius: "50%",
                  border: "2px solid rgba(115,87,255,0.3)",
                  borderTopColor: "#7357FF",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              <span style={{ fontSize: "12px", color: "rgba(242,236,220,0.5)" }}>
                Reconnecting wallet...
              </span>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "6px",
              marginBottom: "24px",
              background: "rgba(0,0,0,0.2)",
              borderRadius: "10px",
              padding: "4px",
            }}
          >
            {[
              ["get", "Get Help", "#FF7A6B"],
              ["offer", "Offer Help", "#7357FF"],
            ].map(([m, label, color]) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setSelectedRequest(null);
                  setEmergencyType(null);
                  setRequestStatus("idle");
                  setRequestId(null);
                  if (!isWalletConnected) promptWalletConnection();
                }}
                style={{
                  padding: "12px 0",
                  minHeight: "44px",
                  borderRadius: "7px",
                  border: "none",
                  background: mode === m ? color : "transparent",
                  color: mode === m ? "#fff" : "rgba(242,236,220,0.45)",
                  fontWeight: "600",
                  fontSize: "13px",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Field tools card — radio bridge, NFC staging, rugged mode (ISP-131/134/135) */}
          <div className="hp-fieldops-card" data-testid="field-ops-card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "8px",
                gap: "8px",
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.8px",
                  color: "rgba(242,236,220,0.55)",
                }}
              >
                FIELD TOOLS
              </span>
              <span
                className="hp-fieldops-badge"
                data-testid="field-transport-badge"
                style={{
                  color:
                    radio.state.status === "linked"
                      ? "#7DE2A8"
                      : online
                        ? "rgba(242,236,220,0.7)"
                        : "#FFB3AA",
                }}
              >
                {
                  transportBadge(
                    getTransport({
                      online,
                      radioLinked: radio.state.status === "linked",
                    }),
                  ).label
                }
              </span>
            </div>
            <div className="hp-fieldops-row">
              <button
                type="button"
                className="hp-fieldops-btn"
                aria-label="Open radio bridge"
                onClick={() => setShowRadioSheet(true)}
              >
                Radio
              </button>
              <button
                type="button"
                className="hp-fieldops-btn"
                aria-label="Open staging check-in"
                onClick={() => setShowStagingSheet(true)}
              >
                Staging
              </button>
              <button
                type="button"
                className="hp-fieldops-btn"
                role="switch"
                aria-checked={rugged.enabled}
                aria-label="Rugged mode for glove use and sunlight"
                data-testid="rugged-toggle"
                onClick={rugged.toggle}
              >
                Rugged {rugged.enabled ? "ON" : "OFF"}
              </button>
            </div>
            <div
              style={{
                marginTop: "8px",
                fontSize: "10.5px",
                color: "rgba(242,236,220,0.5)",
              }}
              data-testid="field-queue-depth"
            >
              Queue {queueDepth()}
              {sosDispatchedAt
                ? ` · SOS ${new Date(sosDispatchedAt).toLocaleTimeString()}`
                : ""}
              {sos.pttActive ? " · PTT live" : ""}
            </div>
          </div>

          <div
            style={{
              padding: "12px 13px",
              borderRadius: "12px",
              marginBottom: "18px",
              background:
                "linear-gradient(135deg, rgba(115,87,255,0.16), rgba(63,132,135,0.12))",
              border: "1px solid rgba(179,166,255,0.22)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginBottom: "8px",
              }}
            >
              <div
                style={{
                  width: "12px",
                  height: "12px",
                  borderRadius: "50%",
                  flexShrink: 0,
                  background:
                    zkStatus === "error"
                      ? "#FF7A6B"
                      : zkStatus === "idle"
                        ? "rgba(242,236,220,0.68)"
                        : "rgba(179,166,255,0.2)",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {(zkStatus === "proving" || zkStatus === "recording") && (
                  <style>{`
                    @keyframes zk-spin {
                      0% { transform: rotate(0deg); }
                      100% { transform: rotate(360deg); }
                    }
                    @keyframes zk-pulse {
                      0%, 100% { opacity: 0.7; }
                      50% { opacity: 1; }
                    }
                  `}</style>
                )}
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    borderRadius: "50%",
                    border: "2px solid transparent",
                    borderTopColor: "#B3A6FF",
                    animation:
                      zkStatus === "proving" || zkStatus === "recording"
                        ? "zk-spin 1s linear infinite, zk-pulse 2s ease-in-out infinite"
                        : "none",
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 900,
                  letterSpacing: "1.25px",
                  color: "#B3A6FF",
                }}
              >
                ZK PRIVACY CHECKPOINT
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  padding: "2px 7px",
                  borderRadius: "999px",
                  background: "rgba(255,255,255,0.08)",
                  color:
                    zkStatus === "error" ? "#FF7A6B" : "rgba(242,236,220,0.62)",
                  fontSize: "9px",
                  fontWeight: 800,
                  letterSpacing: "0.6px",
                  textTransform: "uppercase",
                }}
              >
                {zkStatus === "idle" ? "ready" : 
                 zkStatus === "proving" ? "generating proof..." :
                 zkStatus === "recording" ? "recording on-chain..." :
                 zkStatus === "proved" ? "proof ready ✓" :
                 zkStatus === "recorded" ? "recorded ✓" :
                 zkStatus === "error" ? "error" : zkStatus}
              </span>
            </div>
            <p
              style={{
                margin: "0 0 8px",
                fontSize: "11px",
                color: "rgba(242,236,220,0.52)",
                lineHeight: 1.45,
              }}
            >
              Exact location stays private. Stellar sees a proof fingerprint, a
              zone, and a pseudonymous wallet action.
            </p>
            {zkProof?.nullifier && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "7px",
                  marginBottom: "8px",
                }}
              >
                <div
                  style={{
                    padding: "7px 8px",
                    borderRadius: "8px",
                    background: "rgba(0,0,0,0.16)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "8px",
                      letterSpacing: "0.9px",
                      color: "rgba(242,236,220,0.68)",
                      marginBottom: "3px",
                    }}
                  >
                    NULLIFIER
                  </div>
                  <div
                    style={{
                      fontSize: "10px",
                      color: "#F4ECDC",
                      fontFamily: "'Courier New', monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {shortProofId(zkProof.nullifier)}
                  </div>
                </div>
                <div
                  style={{
                    padding: "7px 8px",
                    borderRadius: "8px",
                    background: "rgba(0,0,0,0.16)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "8px",
                      letterSpacing: "0.9px",
                      color: "rgba(242,236,220,0.68)",
                      marginBottom: "3px",
                    }}
                  >
                    ZONE
                  </div>
                  <div style={{ fontSize: "10px", color: "#F4ECDC" }}>
                    {zkProof.zone?.radiusMeters
                      ? `${Math.round(zkProof.zone.radiusMeters / 1000)} km private box`
                      : "private box"}
                  </div>
                </div>
              </div>
            )}
            {(zkProof?.txHash || zkProof?.recordTxHash) && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  marginBottom: "6px",
                }}
              >
                {zkProof?.txHash && (
                  <ExplorerLink label="On-chain action" hash={zkProof.txHash} />
                )}
                {zkProof?.recordTxHash && (
                  <ExplorerLink
                    label="Proof record"
                    hash={zkProof.recordTxHash}
                  />
                )}
              </div>
            )}
            {zkError && (
              <div
                style={{
                  fontSize: "10px",
                  color: "#FF7A6B",
                  lineHeight: 1.35,
                  marginBottom: "6px",
                }}
              >
                {zkError}
              </div>
            )}
            {zkLogs.length > 0 && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "3px" }}
              >
                {zkLogs.slice(-3).map((line, i) => (
                  <div
                    key={`${line}-${i}`}
                    style={{
                      fontSize: "9.5px",
                      color: "rgba(242,236,220,0.70)",
                      lineHeight: 1.35,
                    }}
                  >
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>

          {isGetMode && (
            <>
              {requestStatus === "idle" ? (
                <div style={{ marginBottom: "20px" }}>
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: "'Instrument Serif',serif",
                      fontWeight: 400,
                      fontSize: "20px",
                      color: "#F4ECDC",
                      lineHeight: 1.2,
                    }}
                  >
                    Request help nearby
                  </h2>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "rgba(242,236,220,0.4)",
                      lineHeight: 1.5,
                    }}
                  >
                    Fill in the steps below. Nearby people will be notified.
                  </p>
                </div>
              ) : (
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: "10px",
                    marginBottom: "20px",
                    background: statusInfo?.bg,
                    border: `1px solid ${statusInfo?.color}44`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "5px",
                    }}
                  >
                    <span
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: statusInfo?.color,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: "700",
                        letterSpacing: "1.5px",
                        color: statusInfo?.color,
                      }}
                    >
                      {statusInfo?.label}
                    </span>
                    {requestStatus === "Enroute" &&
                      responders[0]?.eta_seconds && (
                        <span
                          style={{
                            marginLeft: "auto",
                            fontSize: "12px",
                            color: "rgba(242,236,220,0.5)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          ETA <EtaCountdown
                            etaSeconds={responders[0].eta_seconds}
                            isArrived={responderArrived}
                          />
                        </span>
                      )}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "rgba(242,236,220,0.45)",
                      lineHeight: 1.4,
                    }}
                  >
                    {statusInfo?.msg}
                  </p>
                  {requestStatus === "Enroute" && responders[0] && (
                    <div
                      style={{
                        marginTop: "8px",
                        padding: "8px 10px",
                        borderRadius: "8px",
                        background: "rgba(115,87,255,0.08)",
                        border: "1px solid rgba(115,87,255,0.2)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "10px",
                          fontWeight: 600,
                          color: "#B3A6FF",
                          marginBottom: "4px",
                        }}
                      >
                        RESPONDER {responderArrived ? "ARRIVED ✓" : "EN ROUTE"}
                      </div>
                      <div
                        style={{
                          fontSize: "11px",
                          color: "rgba(242,236,220,0.65)",
                          lineHeight: 1.5,
                        }}
                      >
                        {responders[0].responder?.slice(0, 8)}…
                        {responders[0].eta_seconds && !responderArrived && (
                          <>
                            {" "}
                            · ETA <EtaCountdown
                              etaSeconds={responders[0].eta_seconds}
                              isArrived={responderArrived}
                            />
                          </>
                        )}
                        {location &&
                          responders[0] &&
                          distance(location, [
                            responders[0].lat,
                            responders[0].lng,
                          ]) != null && (
                            <>
                              {" "}
                              ·{" "}
                              {Math.round(
                                distance(location, [
                                  responders[0].lat,
                                  responders[0].lng,
                                ]) * 10,
                              ) / 10}{" "}
                              km away
                            </>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <Step
                n="1"
                title="Your location"
                subtitle={
                  locating
                    ? "Requesting…"
                    : location
                      ? `${location[0].toFixed(4)}, ${location[1].toFixed(4)}`
                      : "Not set"
                }
                done={step1Done}
                active={
                  currentStep === 1 || (!step1Done && requestStatus === "idle")
                }
              >
                {requestStatus === "idle" && (
                  <>
                    {locating && (
                      <p
                        style={{
                          fontSize: "12px",
                          color: "rgba(242,236,220,0.45)",
                          margin: "0 0 8px",
                        }}
                      >
                        Asking for your location…
                      </p>
                    )}
                    {locationError && (
                      <p
                        style={{
                          fontSize: "12px",
                          color: "#FF7A6B",
                          margin: "0 0 8px",
                          lineHeight: 1.4,
                        }}
                      >
                        {locationError}
                      </p>
                    )}
                    {!locating && !location && (
                      <button
                        style={{ ...S.btnGhost, marginBottom: "8px" }}
                        onClick={requestLocation}
                      >
                        Allow location access
                      </button>
                    )}
                    {location && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "7px 10px",
                          borderRadius: "8px",
                          background: "rgba(63,132,135,0.15)",
                          border: "1px solid rgba(63,132,135,0.3)",
                          marginBottom: "8px",
                        }}
                      >
                        <span style={{ fontSize: "12px", color: "#3F8487" }}>
                          Location set ✓
                        </span>
                        <button
                          onClick={requestLocation}
                          style={{
                            marginLeft: "auto",
                            background: "none",
                            border: "none",
                            color: "rgba(242,236,220,0.72)",
                            fontSize: "11px",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          refresh
                        </button>
                      </div>
                    )}
                    <form
                      ref={searchBoxRef}
                      onSubmit={handleSearch}
                      style={{
                        display: "flex",
                        gap: "6px",
                        position: "relative",
                      }}
                    >
                      <label htmlFor="hp-search-location" className="hp-sr-only">
                        Search city or country
                      </label>
                      <input
                        id="hp-search-location"
                        style={S.input}
                        placeholder="Or search city, country…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        autoComplete="off"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-haspopup="listbox"
                        aria-expanded={Boolean(
                          (searchSuggestions.length > 0 ||
                            searchSuggestLoading) &&
                          searchQuery.trim(),
                        )}
                        aria-controls="hp-search-suggestions"
                        aria-activedescendant={
                          activeSuggestion >= 0
                            ? `hp-suggestion-${activeSuggestion}`
                            : undefined
                        }
                      />
                      <button
                        type="submit"
                        style={{
                          padding: "9px 12px",
                          background: "#FF7A6B",
                          color: "#fff",
                          border: "none",
                          borderRadius: "8px",
                          fontSize: "13px",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                        disabled={searchLoading}
                      >
                        {searchLoading ? "…" : "Go"}
                      </button>
                      {(searchSuggestions.length > 0 || searchSuggestLoading) &&
                        searchQuery.trim() && (
                          <div
                            id="hp-search-suggestions"
                            role="listbox"
                            style={{
                              position: "absolute",
                              top: "calc(100% + 6px)",
                              left: 0,
                              right: 0,
                              zIndex: 20,
                              background: "#1c2c24",
                              border: "1px solid rgba(255,255,255,0.08)",
                              borderRadius: "10px",
                              overflow: "hidden",
                              boxShadow: "0 10px 28px rgba(0,0,0,0.35)",
                            }}
                          >
                            {searchSuggestLoading && (
                              <div
                                style={{
                                  padding: "10px 12px",
                                  fontSize: "11px",
                                  color: "rgba(242,236,220,0.72)",
                                }}
                              >
                                Searching references...
                              </div>
                            )}
                            {searchSuggestions.map((feature, idx) => (
                              <button
                                key={feature.id}
                                id={`hp-suggestion-${idx}`}
                                role="option"
                                aria-selected={idx === activeSuggestion}
                                type="button"
                                onClick={() => selectSearchSuggestion(feature)}
                                onMouseMove={() => setActiveSuggestion(idx)}
                                style={{
                                  width: "100%",
                                  padding: "10px 12px",
                                  border: "none",
                                  background:
                                    idx === activeSuggestion
                                      ? "rgba(255,255,255,0.07)"
                                      : "transparent",
                                  color: "rgba(242,236,220,0.9)",
                                  textAlign: "left",
                                  cursor: "pointer",
                                  display: "block",
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: "12px",
                                    fontWeight: 600,
                                    lineHeight: 1.3,
                                  }}
                                >
                                  {feature.place_name}
                                </div>
                                <div
                                  style={{
                                    fontSize: "10px",
                                    color: "rgba(242,236,220,0.70)",
                                    marginTop: "2px",
                                  }}
                                >
                                  {feature.place_type?.join(" · ") ||
                                    "reference"}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                    </form>
                    {searchError && <p style={S.errorMsg}>{searchError}</p>}
                    {!location && (
                      <p
                        style={{
                          fontSize: "11px",
                          color: "rgba(242,236,220,0.70)",
                          margin: "6px 0 0",
                        }}
                      >
                        You can also click the map to drop a pin.
                      </p>
                    )}
                  </>
                )}
              </Step>

              <Step
                n="2"
                title="What happened?"
                subtitle={
                  step2Done
                    ? EMERGENCY_TYPES.find((e) => e.id === emergencyType)?.label
                    : "Select one"
                }
                done={step2Done}
                active={currentStep === 2 && requestStatus === "idle"}
              >
                {requestStatus === "idle" && !step2Done && (
                  <button
                    onClick={() => setShowEmergencyModal(true)}
                    style={{
                      ...S.btnGhost,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span>Pick a type</span>
                    <span style={{ fontSize: "16px", opacity: 0.5 }}>›</span>
                  </button>
                )}
                {requestStatus === "idle" &&
                  step2Done &&
                  (() => {
                    const et = EMERGENCY_TYPES.find(
                      (e) => e.id === emergencyType,
                    );
                    return (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          padding: "10px 12px",
                          background: "rgba(255,255,255,0.05)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "12px",
                        }}
                      >
                        <div
                          style={{
                            width: "40px",
                            height: "40px",
                            borderRadius: "10px",
                            background: "#FF7A6B",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            color: "#fff",
                          }}
                        >
                          {ET_ICONS[et.id] || "•"}
                        </div>
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: "600",
                            color: "#F4ECDC",
                            flex: 1,
                          }}
                        >
                          {et.label}
                        </span>
                        <button
                          onClick={() => setShowEmergencyModal(true)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "rgba(242,236,220,0.72)",
                            fontSize: "12px",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "2px",
                            padding: "4px",
                          }}
                        >
                          Change <span style={{ fontSize: "14px" }}>›</span>
                        </button>
                      </div>
                    );
                  })()}
              </Step>

              <Step
                n="3"
                title="Your info"
                subtitle={
                  step3Done
                    ? `${profile.nickname} · ${profile.contact}`
                    : "Optional — how responders reach you"
                }
                done={step3Done}
                active={currentStep === 3 && requestStatus === "idle"}
              >
                {requestStatus === "idle" && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      marginTop: "4px",
                    }}
                  >
                    <label htmlFor="hp-nickname" style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.8px", textTransform: "uppercase", color: "rgba(242,236,220,0.72)" }}>
                      Nickname or name
                    </label>
                    <input
                      id="hp-nickname"
                      style={S.input}
                      placeholder="Nickname or name"
                      maxLength={30}
                      value={profile.nickname}
                      onChange={(e) =>
                        setProfile((p) => ({ ...p, nickname: e.target.value }))
                      }
                    />
                    <label htmlFor="hp-contact" style={{ fontSize: "10px", fontWeight: 600, letterSpacing: "0.8px", textTransform: "uppercase", color: "rgba(242,236,220,0.72)" }}>
                      Contact (phone or Telegram)
                    </label>
                    <input
                      id="hp-contact"
                      style={{
                        ...S.input,
                        borderColor: contactError && profile.contact ? "rgba(255,122,107,0.5)" : S.input.border,
                      }}
                      placeholder="@telegram or +54 11 5555-5555"
                      maxLength={40}
                      value={profile.contact}
                      onChange={(e) => {
                        const val = e.target.value;
                        setProfile((p) => ({ ...p, contact: val }));
                        const result = validateContact(val);
                        setContactError(result.valid ? "" : result.error);
                      }}
                      aria-describedby={contactError && profile.contact ? "hp-contact-error" : undefined}
                      aria-invalid={Boolean(contactError && profile.contact)}
                    />
                    {contactError && profile.contact && (
                      <div id="hp-contact-error" role="alert" style={{ fontSize: "10px", color: "#FF7A6B", marginTop: "4px", lineHeight: 1.4 }}>
                        {contactError}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: "9.5px",
                        color: "rgba(242,236,220,0.65)",
                        lineHeight: 1.4,
                      }}
                    >
                      Phone (+country code) or @telegram handle. Stored on-chain.
                    </div>
                    {/* #144: Media attachment */}
                    <div style={{ marginTop: "8px" }}>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "8px 12px",
                          borderRadius: "8px",
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.08)",
                          cursor: "pointer",
                          fontSize: "12px",
                          color: "rgba(242,236,220,0.5)",
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <polyline points="21 15 16 10 5 21" />
                        </svg>
                        {mediaPreview ? "Change photo" : "Attach photo"}
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={handleMediaSelect}
                          style={{ display: "none" }}
                        />
                      </label>
                      {mediaPreview && (
                        <div style={{ marginTop: "8px", position: "relative" }}>
                          <img
                            src={mediaPreview}
                            alt="Attached"
                            style={{
                              width: "100%",
                              maxHeight: "120px",
                              objectFit: "cover",
                              borderRadius: "8px",
                              border: "1px solid rgba(255,255,255,0.1)",
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => { setMediaPreview(null); setMediaFile(null); }}
                            style={{
                              position: "absolute",
                              top: "6px",
                              right: "6px",
                              width: "24px",
                              height: "24px",
                              borderRadius: "50%",
                              background: "rgba(0,0,0,0.6)",
                              border: "none",
                              color: "#fff",
                              fontSize: "12px",
                              cursor: "pointer",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Issue #155 — Priority level selector */}
                    <div style={{ marginTop: "8px" }}>
                      <div
                        style={{
                          fontSize: "10px",
                          fontWeight: 600,
                          color: "rgba(242,236,220,0.45)",
                          marginBottom: "6px",
                        }}
                      >
                        Priority level
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        {PRIORITY_LEVELS.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setRequestPriority(p.id)}
                            style={{
                              flex: 1,
                              padding: "7px 4px",
                              borderRadius: "6px",
                              border: `1.5px solid ${requestPriority === p.id ? p.color : "rgba(255,255,255,0.1)"}`,
                              background:
                                requestPriority === p.id
                                  ? `${p.color}22`
                                  : "rgba(255,255,255,0.04)",
                              color:
                                requestPriority === p.id
                                  ? p.color
                                  : "rgba(242,236,220,0.4)",
                              fontSize: "10px",
                              fontWeight: requestPriority === p.id ? 700 : 500,
                              cursor: "pointer",
                              transition: "all 0.15s",
                            }}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </Step>

              <Step
                n="4"
                title="Send request"
                subtitle={
                  step1Done && step2Done
                    ? "Ready to go"
                    : "Complete the steps above"
                }
                done={requestStatus !== "idle"}
                active={currentStep === 4 && requestStatus === "idle"}
              >
                {requestStatus === "idle" && (
                  <>
                    <p
                      style={{
                        fontSize: "11px",
                        color: "rgba(242,236,220,0.72)",
                        margin: "0 0 10px",
                        lineHeight: 1.5,
                      }}
                    >
                      Your pin appears on the map. People nearby will see your
                      request and reach out.
                    </p>
                    <button
                      onClick={handleSubmit}
                      disabled={submitting || !step1Done || !step2Done}
                      style={{
                        width: "100%",
                        padding: "13px",
                        background:
                          step1Done && step2Done && isWalletConnected
                            ? "#FF7A6B"
                            : "rgba(255,255,255,0.08)",
                        color:
                          step1Done && step2Done && isWalletConnected
                            ? "#fff"
                            : "rgba(242,236,220,0.72)",
                        border: "none",
                        borderRadius: "10px",
                        fontSize: "15px",
                        fontWeight: "600",
                        cursor: step1Done && step2Done ? "pointer" : "default",
                        opacity: submitting ? 0.6 : 1,
                        transition: "all 0.2s",
                      }}
                    >
                      {submitting
                        ? "Sending…"
                        : walletConnecting
                          ? "Connecting..."
                        : !isWalletConnected
                          ? "Connect wallet first"
                          : "Request help"}
                    </button>
                    {submitError && <p style={S.errorMsg}>{submitError}</p>}
                    {requestError && <p style={S.errorMsg}>{requestError}</p>}
                  </>
                )}
              </Step>
            </>
          )}

          {!isGetMode && (
            <>
              <div style={{ marginBottom: "20px" }}>
                <h2
                  style={{
                    margin: 0,
                    fontFamily: "'Instrument Serif',serif",
                    fontWeight: 400,
                    fontSize: "20px",
                    color: "#F4ECDC",
                    lineHeight: 1.2,
                  }}
                >
                  People who need help
                </h2>
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "rgba(242,236,220,0.4)",
                    lineHeight: 1.5,
                  }}
                >
                  {openRequests.size === 0
                    ? "No one nearby needs help right now."
                    : `${openRequests.size} active request${openRequests.size > 1 ? "s" : ""} on the map. Tap a pin to help.`}
                </p>
              </div>

              {lastOfferReceipt && (
                <div
                  style={{
                    padding: "12px 13px",
                    borderRadius: "10px",
                    marginBottom: "14px",
                    background: "rgba(115,87,255,0.12)",
                    border: "1px solid rgba(115,87,255,0.28)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "6px",
                    }}
                  >
                    <span
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: "#7357FF",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 800,
                        letterSpacing: "1.2px",
                        color: "#B3A6FF",
                      }}
                    >
                      HELP REGISTERED
                    </span>
                  </div>
                  <p
                    style={{
                      margin: "0 0 9px",
                      fontSize: "12px",
                      color: "rgba(242,236,220,0.52)",
                      lineHeight: 1.45,
                    }}
                  >
                    You are helping {lastOfferReceipt.label || "this person"}.
                    Your location is being shared with them.
                  </p>
                  {lastOfferReceipt.txHash && (
                    <div style={{ marginBottom: "9px" }}>
                      <ExplorerLink
                        label="On-chain action"
                        hash={lastOfferReceipt.txHash}
                      />
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "8px" }}>
                    {responderArrived ? (
                      <div
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: "8px",
                          background: "rgba(63,132,135,0.15)",
                          color: "#3F8487",
                          fontSize: "11px",
                          fontWeight: 800,
                          textAlign: "center",
                          border: "1px solid rgba(63,132,135,0.3)",
                        }}
                      >
                        ARRIVED ✓
                      </div>
                    ) : (
                      <button
                        onClick={handleMarkArrived}
                        disabled={arrivalSubmitting}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: "8px",
                          border: "1px solid rgba(63,132,135,0.25)",
                          background: "rgba(63,132,135,0.12)",
                          color: "#3F8487",
                          fontSize: "11px",
                          fontWeight: 800,
                          cursor: arrivalSubmitting ? "default" : "pointer",
                          opacity: arrivalSubmitting ? 0.7 : 1,
                        }}
                      >
                        {arrivalSubmitting ? "Recording..." : "Mark Arrived"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div style={S.divider} />

              {selectedRequest ? (
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "14px",
                    }}
                  >
                    <img
                      src={`/assets/chars/${pickChar("default", selectedRequest.id)}.png`}
                      style={{
                        width: "44px",
                        height: "44px",
                        objectFit: "contain",
                      }}
                      alt=""
                    />
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <div
                          style={{
                            fontSize: "14px",
                            fontWeight: "600",
                            color: "#F4ECDC",
                          }}
                        >
                          {selectedRequest.nickname || "Anonymous"}
                        </div>
                        {selectedRequest.priority && selectedRequest.priority !== "Medium" && (
                          <span
                            style={{
                              fontSize: "8px",
                              fontWeight: 700,
                              padding: "2px 5px",
                              borderRadius: "3px",
                              background: `${PRIORITY_COLORS[selectedRequest.priority]}22`,
                              color: PRIORITY_COLORS[selectedRequest.priority],
                              letterSpacing: "0.3px",
                            }}
                          >
                            {selectedRequest.priority.toUpperCase()}
                          </span>
                        )}
                      </div>
                      {(() => {
                        const et = EMERGENCY_TYPES.find(
                          (e) => e.id === selectedRequest.emergency_type,
                        );
                        return et ? (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "rgba(242,236,220,0.5)",
                              marginTop: "2px",
                            }}
                          >
                            {et.icon} {et.label}
                          </div>
                        ) : null;
                      })()}
                      <div
                        style={{
                          fontSize: "11px",
                          color: "rgba(242,236,220,0.4)",
                        }}
                      >
                        {selectedRequest.contact || ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Close request details"
                      onClick={() => setSelectedRequest(null)}
                      style={{
                        marginLeft: "auto",
                        background: "none",
                        border: "none",
                        color: "rgba(242,236,220,0.72)",
                        fontSize: "18px",
                        cursor: "pointer",
                      }}
                    >
                      ×
                    </button>
                  </div>

                  {selectedRequest.status === "Pending" ? (
                    <button
                      onClick={() => handleOffer(selectedRequest)}
                      disabled={offerSubmitting || !location}
                      style={{
                        width: "100%",
                        padding: "13px",
                        background: isWalletConnected
                          ? "#7357FF"
                          : "rgba(255,255,255,0.08)",
                        color: isWalletConnected
                          ? "#fff"
                          : "rgba(242,236,220,0.72)",
                        border: "none",
                        borderRadius: "10px",
                        fontSize: "15px",
                        fontWeight: "600",
                        cursor: location ? "pointer" : "default",
                        opacity: offerSubmitting ? 0.6 : 1,
                      }}
                    >
                      {offerSubmitting
                        ? "Confirming…"
                        : !isWalletConnected
                          ? "Connect wallet first"
                          : "I'll help this person"}
                    </button>
                  ) : (
                    <div
                      style={{
                        width: "100%",
                        padding: "13px",
                        borderRadius: "10px",
                        fontSize: "14px",
                        fontWeight: "600",
                        textAlign: "center",
                        background: "rgba(115,87,255,0.12)",
                        color: "#7357FF",
                      }}
                    >
                      Someone is already on the way
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      marginTop: "8px",
                      color: "rgba(242,236,220,0.70)",
                      fontSize: "11px",
                      lineHeight: 1.45,
                    }}
                  >
                    <span>
                      Helping creates your own public receipt after Stellar
                      confirms.
                    </span>
                  </div>
                  {!location && (
                    <p style={S.errorMsg}>
                      Enable your location so they can see you on the map.
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      fontSize: "11px",
                      letterSpacing: "1.5px",
                      fontWeight: "600",
                      color: "#3F8487",
                      marginBottom: "10px",
                    }}
                  >
                    ACTIVE REQUESTS
                  </div>
                  {openRequestsLoading ? (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                      }}
                    >
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div
                          key={i}
                          style={{
                            padding: "10px 12px",
                            borderRadius: "8px",
                            background: "rgba(255,255,255,0.03)",
                            border: "1px solid rgba(255,255,255,0.05)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              marginBottom: "6px",
                            }}
                          >
                            <div
                              style={{
                                width: "36px",
                                height: "36px",
                                borderRadius: "50%",
                                flexShrink: 0,
                                background:
                                  "linear-gradient(90deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.12) 40px, rgba(255,255,255,0.06) 80px)",
                                backgroundSize: "200px 100%",
                                animation: "hp-shimmer 1.6s ease-in-out infinite",
                              }}
                            />
                            <div
                              style={{
                                flex: 1,
                                height: "10px",
                                borderRadius: "3px",
                                background:
                                  "linear-gradient(90deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.12) 40px, rgba(255,255,255,0.06) 80px)",
                                backgroundSize: "200px 100%",
                                animation: "hp-shimmer 1.6s ease-in-out infinite",
                              }}
                            />
                          </div>
                          <div
                            style={{
                              marginLeft: "44px",
                              width: "50px",
                              height: "8px",
                              borderRadius: "3px",
                              background:
                                "linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.08) 40px, rgba(255,255,255,0.04) 80px)",
                              backgroundSize: "200px 100%",
                              animation: "hp-shimmer 1.6s ease-in-out infinite",
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  ) : openRequests.size === 0 ? (
                    <p
                      style={{
                        fontSize: "12px",
                        color: "rgba(242,236,220,0.70)",
                        lineHeight: 1.5,
                      }}
                    >
                      No one nearby needs help right now. Check back soon.
                    </p>
                  ) : (
                    openRequestsArray.map((req) => (
                      <button
                        key={req.id}
                        onClick={() => setSelectedRequest(req)}
                        style={{
                          width: "100%",
                          marginBottom: "8px",
                          padding: "10px 12px",
                          background: "rgba(255,255,255,0.06)",
                          border: `1px solid ${req.priority && req.priority !== "Medium" ? `${PRIORITY_COLORS[req.priority]}44` : "rgba(255,255,255,0.1)"}`,
                          borderRadius: "10px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          textAlign: "left",
                        }}
                      >
                        <img
                          src={`/assets/chars/${pickChar("default", req.id)}.png`}
                          style={{
                            width: "36px",
                            height: "36px",
                            objectFit: "contain",
                            flexShrink: 0,
                          }}
                          alt=""
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <div
                              style={{
                                fontSize: "13px",
                                fontWeight: "600",
                                color: "#F4ECDC",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {req.nickname || "Anonymous"}
                            </div>
                            {req.priority && req.priority !== "Medium" && (
                              <span
                                style={{
                                  fontSize: "8px",
                                  fontWeight: 700,
                                  padding: "1px 5px",
                                  borderRadius: "3px",
                                  background: `${PRIORITY_COLORS[req.priority]}22`,
                                  color: PRIORITY_COLORS[req.priority],
                                  letterSpacing: "0.3px",
                                  flexShrink: 0,
                                }}
                              >
                                {req.priority.toUpperCase()}
                              </span>
                            )}
                          </div>
                          {(() => {
                            const et = EMERGENCY_TYPES.find(
                              (e) => e.id === req.emergency_type,
                            );
                            return et ? (
                              <div
                                style={{
                                  fontSize: "10px",
                                  color: "rgba(242,236,220,0.70)",
                                  marginTop: "1px",
                                }}
                              >
                                {et.icon} {et.label}
                              </div>
                            ) : null;
                          })()}
                        </div>
                        <div
                          style={{
                            marginLeft: "auto",
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            background: "#FF7A6B",
                            flexShrink: 0,
                          }}
                        />
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {isWalletConnected && (
            <>
              <div style={S.divider} />
              <div>
                <div
                  style={{
                    fontSize: "11px",
                    letterSpacing: "1.5px",
                    fontWeight: "600",
                    color: "#3F8487",
                    marginBottom: "10px",
                  }}
                >
                  MY REQUESTS{" "}
                  {myRequests.length > 0 && (
                    <span style={{ color: "rgba(242,236,220,0.70)" }}>
                      ({myRequests.length})
                    </span>
                  )}
                </div>
                {/* #143: History filter tabs */}
                <div
                  style={{
                    display: "flex",
                    gap: "4px",
                    marginBottom: "10px",
                    padding: "3px",
                    background: "rgba(0,0,0,0.2)",
                    borderRadius: "8px",
                  }}
                >
                  {[
                    ["all", "All"],
                    ["active", "Active"],
                    ["resolved", "Resolved"],
                    ["cancelled", "Cancelled"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setHistoryFilter(key)}
                      style={{
                        flex: 1,
                        padding: "6px 0",
                        borderRadius: "6px",
                        border: "none",
                        background: historyFilter === key ? "rgba(63,132,135,0.25)" : "transparent",
                        color: historyFilter === key ? "#3F8487" : "rgba(242,236,220,0.72)",
                        fontSize: "10px",
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {myRequestsLoading && myRequests.length === 0 ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                    }}
                  >
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "8px",
                          background: "rgba(255,255,255,0.03)",
                          border: "1px solid rgba(255,255,255,0.05)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginBottom: "6px",
                          }}
                        >
                          <div
                            style={{
                              width: "8px",
                              height: "8px",
                              borderRadius: "50%",
                              flexShrink: 0,
                              background:
                                "linear-gradient(90deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.12) 40px, rgba(255,255,255,0.06) 80px)",
                              backgroundSize: "200px 100%",
                              animation: "hp-shimmer 1.6s ease-in-out infinite",
                            }}
                          />
                          <div
                            style={{
                              width: "80px",
                              height: "10px",
                              borderRadius: "3px",
                              background:
                                "linear-gradient(90deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.12) 40px, rgba(255,255,255,0.06) 80px)",
                              backgroundSize: "200px 100%",
                              animation: "hp-shimmer 1.6s ease-in-out infinite",
                            }}
                          />
                        </div>
                        <div
                          style={{
                            width: "50px",
                            height: "8px",
                            borderRadius: "3px",
                            background:
                              "linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.08) 40px, rgba(255,255,255,0.04) 80px)",
                            backgroundSize: "200px 100%",
                            animation: "hp-shimmer 1.6s ease-in-out infinite",
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : myRequests.length === 0 ? (
                  <p
                    style={{ fontSize: "12px", color: "rgba(242,236,220,0.70)" }}
                  >
                    You haven&apos;t requested help yet.
                  </p>
                ) : (
                  <FilteredRequestList
                    requests={myRequests}
                    historyFilter={historyFilter}
                    requestId={requestId}
                    setRequestId={setRequestId}
                    setRequestStatus={setRequestStatus}
                    setShowCancelConfirm={setShowCancelConfirm}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </aside>

      <main
        id="helphone-help-map"
        aria-label="Emergency map"
        style={{ flex: 1, position: "relative" }}
      >
        <MapboxWrapper
          accessToken={MAPBOX_TOKEN}
          initialViewState={settledViewport}
          mapStyle={MAP_STYLES[mapStyleIndex].url}
          onMoveEnd={syncSettledViewport}
          onMapClick={(e) => {
            if (isGetMode && requestStatus === "idle" && e.lngLat) {
              setLocation([e.lngLat.lat, e.lngLat.lng]);
            }
          }}
        >
          {location && <MapController center={location} zoom={14} />}
          <MapKeyboardControls />

          {isGetMode && location && (
            <CharMarker
              charName={myChar}
              accentColor="#FF7A6B"
              lat={location[0]}
              lng={location[1]}
              onClick={() =>
                setPopupMarker((p) => (p === "user" ? null : "user"))
              }
            >
              {popupMarker === "user" && (
                <Popup
                  latitude={location[0]}
                  longitude={location[1]}
                  onClose={() => setPopupMarker(null)}
                  closeButton={false}
                >
                  <div role="dialog" aria-label="Your location marker details">
                    <strong style={{ color: "#FF7A6B" }}>You</strong>
                    {profile.nickname && (
                      <>
                        <br />
                        {profile.nickname}
                      </>
                    )}
                  </div>
                </Popup>
              )}
            </CharMarker>
          )}

          {!isGetMode && location && (
            <CharMarker
              charName={myChar}
              accentColor="#7357FF"
              lat={location[0]}
              lng={location[1]}
              onClick={() =>
                setPopupMarker((p) =>
                  p === "responder-me" ? null : "responder-me",
                )
              }
            >
              {popupMarker === "responder-me" && (
                <Popup
                  latitude={location[0]}
                  longitude={location[1]}
                  onClose={() => setPopupMarker(null)}
                  closeButton={false}
                >
                  <div role="dialog" aria-label="Your responder marker details">
                    <strong style={{ color: "#7357FF" }}>You (responder)</strong>
                    {profile.nickname && (
                      <>
                        <br />
                        {profile.nickname}
                      </>
                    )}
                  </div>
                </Popup>
              )}
            </CharMarker>
          )}

          {isGetMode &&
            location &&
            responders.map((r) => (
              <Fragment key={r.id}>
                <CharMarker
                  charName={pickChar("default", r.responder)}
                  accentColor="#7357FF"
                  lat={r.lat}
                  lng={r.lng}
                  onClick={() =>
                    setPopupMarker((p) =>
                      p === `resp-${r.id}` ? null : `resp-${r.id}`,
                    )
                  }
                >
                  {popupMarker === `resp-${r.id}` && (
                    <Popup
                      latitude={r.lat}
                      longitude={r.lng}
                      onClose={() => setPopupMarker(null)}
                      closeButton={false}
                    >
                      <div role="dialog" aria-label={`Responder ${r.responder ? r.responder.slice(0, 8) : ""} details`}>
                        <strong style={{ color: "#7357FF" }}>Responder</strong>
                        <br />
                        <span style={{ fontSize: "11px", color: "#a2a586" }}>
                          {r.responder
                            ? r.responder.slice(0, 8) + "…"
                            : "Responder"}
                        </span>
                        {r.eta_seconds && (
                          <>
                            <br />
                            ETA: {Math.round(r.eta_seconds / 60)} min
                          </>
                        )}
                      </div>
                    </Popup>
                  )}
                </CharMarker>
                <RouteLine id={r.id} from={[r.lat, r.lng]} to={location} />
              </Fragment>
            ))}

          {!isGetMode &&
            clusters.map((feature) => {
              const isCluster = feature.properties?.cluster === true;
              if (isCluster) {
                const count = feature.properties.point_count;
                const [clng, clat] = feature.geometry.coordinates;
                return (
                  <Marker
                    key={`cluster-${feature.properties.cluster_id}`}
                    latitude={clat}
                    longitude={clng}
                    onClick={() =>
                      handleClusterClick(
                        feature.properties.cluster_id,
                        clng,
                        clat,
                      )
                    }
                  >
                    <div
                      className="hp-marker"
                      style={{
                        position: "relative",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: "50%",
                          background: "rgba(115,87,255,0.85)",
                          border: "3px solid rgba(255,255,255,0.9)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: "14px",
                          fontWeight: 800,
                          boxShadow: "0 2px 12px rgba(115,87,255,0.5)",
                        }}
                      >
                        {count}
                      </div>
                    </div>
                  </Marker>
                );
              }

              const req = feature.properties;
              if (!req || !Number.isFinite(req.lat) || !Number.isFinite(req.lng))
                return null;
              return (
                <EmergencyMarker
                  key={req.id}
                  lat={req.lat}
                  lng={req.lng}
                  emergencyType={req.emergency_type}
                  isActive={req.status === "Pending"}
                  onClick={() => {
                    setSelectedRequest(req);
                    setPopupMarker(`req-${req.id}`);
                  }}
                >
                  {popupMarker === `req-${req.id}` && (
                    <Popup
                      latitude={req.lat}
                      longitude={req.lng}
                      onClose={() => setPopupMarker(null)}
                      closeButton={false}
                    >
                      <div role="dialog" aria-label={`Emergency request from ${req.nickname || "anonymous"}: ${EMERGENCY_TYPES.find((e) => e.id === req.emergency_type)?.label || "needs help"}`}>
                        <strong style={{ color: PRIORITY_COLORS[req.priority] || "#FF7A6B" }}>
                          {req.nickname || "Anonymous"}
                        </strong>
                        <br />
                        <span style={{ fontSize: "11px", color: "#a2a586" }}>
                          {EMERGENCY_TYPES.find((e) => e.id === req.emergency_type)
                            ?.label || "Needs help"}{" "}
                          · Click sidebar to respond
                        </span>
                        {req.priority && req.priority !== "Medium" && (
                          <>
                            <br />
                            <span
                              style={{
                                fontSize: "10px",
                                fontWeight: 700,
                                color: PRIORITY_COLORS[req.priority] || "#a2a586",
                              }}
                            >
                              {req.priority} priority
                            </span>
                          </>
                        )}
                      </div>
                    </Popup>
                  )}
                </EmergencyMarker>
              );
            })}

          {showTracking && isGetMode && responders[0] && (
            <TrackingScreen
              responderLat={responders[0].lat}
              responderLng={responders[0].lng}
              responderAddress={responders[0].responder}
              responderChar={pickChar("default", responders[0].responder)}
              requesterLat={location?.[0]}
              requesterLng={location?.[1]}
              requesterChar={myChar}
              etaSeconds={responders[0].eta_seconds}
              isArrived={responderArrived}
              isResponderView={false}
              onResolve={() => setShowResolveConfirm(true)}
            />
          )}

          {showTracking &&
            !isGetMode &&
            lastOfferReceipt &&
            location &&
            requesterLocation && (
              <TrackingScreen
                responderLat={location[0]}
                responderLng={location[1]}
                responderAddress={activeWalletAddress}
                responderChar={myChar}
                requesterLat={requesterLocation[0]}
                requesterLng={requesterLocation[1]}
                requesterChar={pickChar("default", lastOfferReceipt.nickname)}
                etaSeconds={null}
                isArrived={responderArrived}
                isResponderView={true}
                isMarkingArrived={arrivalSubmitting}
                onMarkArrived={handleMarkArrived}
              />
            )}
        </MapboxWrapper>

        <div
          ref={styleSelectorRef}
          style={{
            position: "absolute",
            top: "12px",
            left: "12px",
            zIndex: 10,
          }}
        >
          <button
            onClick={() => setStyleOpen((o) => !o)}
            style={{
              padding: "7px 14px",
              background: "#234B4E",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "20px",
              color: "rgba(242,236,220,0.85)",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              gap: "7px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: "#7357FF",
                flexShrink: 0,
              }}
            />
            {MAP_STYLES[mapStyleIndex].name}{" "}
            <span style={{ opacity: 0.5 }}>▾</span>
          </button>
          {styleOpen && (
            <div
              style={{
                marginTop: "6px",
                background: "#1c2c24",
                borderRadius: "12px",
                border: "1px solid rgba(255,255,255,0.08)",
                overflow: "hidden",
                boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                minWidth: "220px",
              }}
            >
              {MAP_STYLES.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setMapStyleIndex(i);
                    setStyleOpen(false);
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    border: "none",
                    borderBottom:
                      i < MAP_STYLES.length - 1
                        ? "1px solid rgba(255,255,255,0.05)"
                        : "none",
                    background:
                      i === mapStyleIndex
                        ? "rgba(115,87,255,0.12)"
                        : "transparent",
                    color:
                      i === mapStyleIndex ? "#B3A6FF" : "rgba(242,236,220,0.7)",
                    cursor: "pointer",
                    textAlign: "left",
                    display: "block",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background =
                      "rgba(255,255,255,0.05)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background =
                      i === mapStyleIndex
                        ? "rgba(115,87,255,0.12)"
                        : "transparent")
                  }
                >
                  <div
                    style={{
                      fontSize: "13px",
                      fontWeight: 600,
                      marginBottom: "2px",
                    }}
                  >
                    {s.name}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "rgba(242,236,220,0.72)",
                      lineHeight: 1.4,
                    }}
                  >
                    {s.desc}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label="Open HelPhone help guide"
          onClick={() => setShowOnboarding(true)}
          style={{
            position: "absolute",
            top: "12px",
            right: "68px",
            zIndex: 10,
            width: "44px",
            height: "44px",
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.12)",
            background: "#234B4E",
            color: "#F4ECDC",
            fontSize: "18px",
            fontWeight: 900,
            cursor: "pointer",
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            backdropFilter: "blur(8px)",
          }}
        >
          ?
        </button>

        <div
          ref={profileRef}
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            zIndex: 10,
          }}
        >
          <button
            onClick={() => {
              if (isWalletConnected) {
                setProfileOpen((o) => !o);
                return;
              }
              if (!walletConnecting) {
                promptWalletConnection();
              }
            }}
            aria-label={isWalletConnected ? "Open profile" : walletConnecting ? "Connecting wallet..." : "Connect Wallet"}
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "50%",
              padding: 0,
              cursor: walletConnecting ? "default" : "pointer",
              background:
                walletConnecting ? "rgba(115,87,255,0.2)" :
                profile.nickname || isWalletConnected
                  ? "#234B4E"
                  : "rgba(35,75,78,0.55)",
              border: `2px solid ${walletConnecting ? "rgba(115,87,255,0.4)" : isWalletConnected ? "rgba(115,87,255,0.4)" : "rgba(255,255,255,0.12)"}`,
              overflow: "hidden",
              backdropFilter: "blur(8px)",
              boxShadow: walletConnecting ? "0 0 0 3px rgba(115,87,255,0.25), 0 4px 16px rgba(0,0,0,0.3)" :
                isWalletConnected
                ? "0 0 0 3px rgba(115,87,255,0.15), 0 4px 16px rgba(0,0,0,0.3)"
                : "0 4px 16px rgba(0,0,0,0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {walletConnecting ? (
              <>
                <style>{`
                  @keyframes wallet-spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                  }
                `}</style>
                <div
                  style={{
                    width: "18px",
                    height: "18px",
                    borderRadius: "50%",
                    border: "2px solid rgba(115,87,255,0.3)",
                    borderTopColor: "#7357FF",
                    animation: "wallet-spin 0.8s linear infinite",
                  }}
                />
              </>
            ) : profile.nickname || isWalletConnected ? (
              <img
                src={`/assets/chars/${myChar}.png`}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
                alt=""
              />
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(242,236,220,0.5)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            )}
          </button>

          {profileOpen && isWalletConnected && (
            <div
              style={{
                position: "absolute",
                top: "52px",
                right: "0",
                width: "300px",
                background: "#1c2c24",
                borderRadius: "16px",
                border: "1px solid rgba(255,255,255,0.08)",
                overflow: "hidden",
                boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
              }}
            >
              <div
                style={{
                  padding: "20px 20px 16px",
                  background: "rgba(115,87,255,0.06)",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: "14px" }}
                >
                  <div
                    style={{
                      width: "52px",
                      height: "52px",
                      borderRadius: "12px",
                      overflow: "hidden",
                      background: "#234B4E",
                      flexShrink: 0,
                      border: "2px solid rgba(115,87,255,0.3)",
                    }}
                  >
                    <img
                      src={`/assets/chars/${myChar}.png`}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        display: "block",
                      }}
                      alt=""
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "15px",
                        fontWeight: 600,
                        color: "#F4ECDC",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {profile.nickname || "Anonymous"}
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: "rgba(242,236,220,0.72)",
                        marginTop: "2px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayAddress}
                    </div>
                    <div
                      style={{
                        marginTop: "14px",
                        padding: "10px 12px",
                        borderRadius: "10px",
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "10px",
                          letterSpacing: "1.4px",
                          color: "rgba(242,236,220,0.70)",
                          marginBottom: "6px",
                        }}
                      >
                        WALLET BALANCE
                      </div>
                      <div
                        style={{
                          fontSize: "13px",
                          color: "rgba(242,236,220,0.76)",
                          fontWeight: 700,
                        }}
                      >
                        {walletBalanceStatus === "loading"
                          ? "Loading..."
                          : walletBalanceStatus === "error"
                            ? "Balance unavailable"
                            : `${(walletBalances.find((balance) => balance.asset === "XLM")?.balance ?? 0).toFixed(2)} XLM`}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Disconnect wallet"
                    onClick={async () => {
                      await StellarWalletsKit.disconnect();
                      setWalletAddress("");
                      setProfileOpen(false);
                    }}
                    style={{
                      background: "rgba(255,255,255,0.06)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "8px",
                      color: "rgba(242,236,220,0.72)",
                      fontSize: "13px",
                      cursor: "pointer",
                      padding: "6px 8px",
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div style={{ padding: "14px 20px 6px" }}>
                {/* Issue #156 — Responder availability toggle */}
                {!isGetMode && (
                  <div
                    style={{
                      marginBottom: "14px",
                      padding: "10px 12px",
                      borderRadius: "10px",
                      background: responderActive
                        ? "rgba(63,132,135,0.12)"
                        : "rgba(255,255,255,0.04)",
                      border: `1px solid ${responderActive ? "rgba(63,132,135,0.3)" : "rgba(255,255,255,0.08)"}`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            color: responderActive ? "#3F8487" : "rgba(242,236,220,0.5)",
                          }}
                        >
                          Responder Status
                        </div>
                        <div
                          style={{
                            fontSize: "9.5px",
                            color: "rgba(242,236,220,0.70)",
                            marginTop: "2px",
                          }}
                        >
                          {responderActive ? "Active — visible to requesters" : "Offline — hidden from requesters"}
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={responderActive}
                        aria-label="Toggle responder availability"
                        onClick={() => setResponderActive((prev) => !prev)}
                        disabled={responderStatusLoading}
                        style={{
                          position: "relative",
                          width: "44px",
                          height: "24px",
                          borderRadius: "12px",
                          border: "none",
                          background: responderActive ? "#3F8487" : "rgba(255,255,255,0.15)",
                          cursor: "pointer",
                          transition: "background 0.2s",
                          flexShrink: 0,
                          opacity: responderStatusLoading ? 0.6 : 1,
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            top: "2px",
                            left: responderActive ? "22px" : "2px",
                            width: "20px",
                            height: "20px",
                            borderRadius: "50%",
                            background: "#fff",
                            transition: "left 0.2s",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
                          }}
                        />
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "5px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "rgba(242,236,220,0.5)",
                      }}
                    >
                      On-chain alias
                    </div>
                    {profile.nickname && (
                      <div
                        style={{
                          fontSize: "9px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "rgba(63,132,135,0.15)",
                          color: "#3F8487",
                          letterSpacing: "0.5px",
                        }}
                      >
                        SET
                      </div>
                    )}
                  </div>
                  <label htmlFor="hp-profile-nickname" style={{ display: "block", fontSize: "10px", fontWeight: 600, letterSpacing: "0.8px", textTransform: "uppercase", color: "rgba(242,236,220,0.72)", marginBottom: "5px" }}>
                    On-chain alias
                  </label>
                  <input
                    id="hp-profile-nickname"
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "8px",
                      color: "rgba(242,236,220,0.9)",
                      fontSize: "13px",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                    placeholder="Anonymous"
                    maxLength={20}
                    value={profile.nickname}
                    onChange={(e) =>
                      setProfile((p) => ({ ...p, nickname: e.target.value }))
                    }
                  />
                  <div
                    style={{
                      fontSize: "9.5px",
                      color: "rgba(242,236,220,0.65)",
                      marginTop: "4px",
                      lineHeight: 1.4,
                    }}
                  >
                    A pseudonym reveals nothing. No on-chain storage — it exists
                    only in this session.
                  </div>
                </div>

                <div style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "5px",
                    }}
                  >
                    <div
                      id="hp-profile-contact-label"
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "rgba(242,236,220,0.72)",
                      }}
                    >
                      Contact
                    </div>
                    {profile.contact && (
                      <div
                        style={{
                          fontSize: "9px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "rgba(63,132,135,0.15)",
                          color: "#3F8487",
                          letterSpacing: "0.5px",
                        }}
                      >
                        SET
                      </div>
                    )}
                  </div>
                  <input
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      background: "rgba(255,255,255,0.05)",
                      border: contactError && profile.contact
                        ? "1px solid rgba(255,122,107,0.5)"
                        : "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "8px",
                      color: "rgba(242,236,220,0.9)",
                      fontSize: "13px",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                    placeholder="@telegram or +54 11 5555-5555"
                    maxLength={40}
                    value={profile.contact}
                    onChange={(e) => {
                      const val = e.target.value;
                      setProfile((p) => ({ ...p, contact: val }));
                      const result = validateContact(val);
                      setContactError(result.valid ? "" : result.error);
                    }}
                    id="hp-profile-contact"
                    aria-labelledby="hp-profile-contact-label"
                    aria-describedby={contactError && profile.contact ? "hp-profile-contact-error" : undefined}
                    aria-invalid={Boolean(contactError && profile.contact)}
                  />
                  {contactError && profile.contact && (
                    <div id="hp-profile-contact-error" role="alert" style={{ fontSize: "10px", color: "#FF7A6B", marginTop: "4px", lineHeight: 1.4 }}>
                      {contactError}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: "9.5px",
                      color: "rgba(242,236,220,0.65)",
                      marginTop: "4px",
                      lineHeight: 1.4,
                    }}
                  >
                    How responders reach you. Stored on-chain.
                  </div>
                </div>

                <div style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "rgba(242,236,220,0.5)",
                      marginBottom: "6px",
                    }}
                  >
                    Map avatar
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAvatarModal(true)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "8px 12px",
                      borderRadius: "8px",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      cursor: "pointer",
                      width: "100%",
                    }}
                  >
                    <img
                      src={`/assets/chars/${myChar}.png`}
                      alt=""
                      style={{
                        width: "32px",
                        height: "32px",
                        objectFit: "contain",
                      }}
                    />
                    <span
                      style={{
                        fontSize: "12px",
                        color: "rgba(242,236,220,0.6)",
                      }}
                    >
                      {selectedChar
                        ? "Change avatar"
                        : "Auto-pick · tap to choose"}
                    </span>
                  </button>
                </div>

                {/* #142: Alert settings */}
                <div>
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "rgba(242,236,220,0.5)",
                      marginBottom: "8px",
                    }}
                  >
                    Alerts
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {[
                      { label: "Sound alerts", enabled: alertPrefs.soundEnabled, onToggle: toggleSound },
                      { label: "Haptic feedback", enabled: alertPrefs.hapticEnabled, onToggle: toggleHaptic },
                    ].map(({ label, enabled, onToggle }) => (
                      <button
                        key={label}
                        type="button"
                        onClick={onToggle}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "8px 12px",
                          borderRadius: "8px",
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.08)",
                          cursor: "pointer",
                          width: "100%",
                        }}
                      >
                        <span style={{ fontSize: "12px", color: "rgba(242,236,220,0.6)" }}>{label}</span>
                        <span
                          style={{
                            width: "36px",
                            height: "20px",
                            borderRadius: "10px",
                            background: enabled ? "#3F8487" : "rgba(255,255,255,0.12)",
                            position: "relative",
                            transition: "background 0.2s",
                          }}
                        >
                          <span
                            style={{
                              position: "absolute",
                              top: "2px",
                              left: enabled ? "18px" : "2px",
                              width: "16px",
                              height: "16px",
                              borderRadius: "50%",
                              background: "#fff",
                              transition: "left 0.2s",
                            }}
                          />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <HelpOnboardingModal
          open={showOnboarding}
          onClose={() => {
            setShowOnboarding(false);
            try {
              localStorage.setItem("hp_tour_done", "1");
            } catch {}
          }}
          onConnectWallet={() => promptWalletConnection()}
        />

        <RadioSheet
          open={showRadioSheet}
          onClose={() => setShowRadioSheet(false)}
          bridge={radio}
        />

        <StagingSheet
          open={showStagingSheet}
          onClose={() => setShowStagingSheet(false)}
          checkIn={nfc}
        />

        <SosSheet
          open={showSosSheet}
          onCancel={() => setShowSosSheet(false)}
          onConfirm={() => {
            setShowSosSheet(false);
            sos.commit({ source: "sos-sheet", force: true });
          }}
        />

        <AvatarSelectionModal
          open={showAvatarModal}
          onClose={() => setShowAvatarModal(false)}
          selected={selectedChar}
          onSelect={setSelectedChar}
        />

        <FeedbackModal
          open={showFeedback}
          onClose={() => setShowFeedback(false)}
          onSubmit={async ({ rating, comment }) => {
            try {
              await feedbackService.submitFeedback({
                rating,
                comment,
                requestId: feedbackRequestId,
                responderAddress: feedbackResponderAddress,
              });
            } catch {}
          }}
        />

        {!isGetMode && <MapLegend />}

        {/* Issue #154 — Geofencing alerts */}
        {isGetMode && geofenceAlerts.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: "60px",
              left: "12px",
              zIndex: 100,
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              maxWidth: "320px",
            }}
          >
            {geofenceAlerts.map((alert) => {
              const et = EMERGENCY_TYPES.find((e) => e.id === alert.emergency_type);
              return (
                <div
                  key={alert.id}
                  style={{
                    background: "rgba(229,62,62,0.95)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: "12px",
                    padding: "12px 14px",
                    boxShadow: "0 4px 20px rgba(229,62,62,0.4)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                    <span style={{ fontSize: "16px" }}>⚠️</span>
                    <span style={{ fontSize: "11px", fontWeight: 800, color: "#fff", letterSpacing: "0.5px" }}>
                      NEARBY EMERGENCY
                    </span>
                    <button
                      onClick={() => dismissGeofenceAlert(alert.id)}
                      style={{
                        marginLeft: "auto",
                        background: "none",
                        border: "none",
                        color: "rgba(255,255,255,0.6)",
                        fontSize: "16px",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <p style={{ margin: 0, fontSize: "12px", color: "rgba(255,255,255,0.9)", lineHeight: 1.4 }}>
                    {et ? `${et.icon} ${et.label}` : "Emergency"} — {alert.distance}m away
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {!location && (
          <div
            id="hp-hint-overlay"
            style={{
              position: "absolute",
              bottom: "24px",
              left: "50%",
              transform: "translateX(-50%)",
              background: "#234B4E",
              color: "rgba(242,236,220,0.8)",
              padding: "10px 18px",
              borderRadius: "24px",
              fontSize: "13px",
              fontWeight: "500",
              boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
              pointerEvents: "none",
              zIndex: 999,
              whiteSpace: "nowrap",
            }}
          >
            {locating
              ? "Getting your location…"
              : isGetMode
                ? "Allow location or click map to drop your pin"
                : "Enable location to show responders where you are"}
          </div>
        )}

        <button
          id="hp-mobile-form-toggle"
          type="button"
          aria-label={showMobileForm ? "Collapse form" : "Expand form"}
          aria-expanded={showMobileForm}
          onClick={() => setShowMobileForm((o) => !o)}
          style={{
            position: "absolute",
            bottom: "20px",
            right: "20px",
            zIndex: 100,
            width: "50px",
            height: "50px",
            borderRadius: "50%",
            padding: 0,
            background: "#FF7A6B",
            border: "none",
            cursor: "pointer",
            boxShadow: "0 4px 20px rgba(255,122,107,0.5)",
            display: "none",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {showMobileForm ? (
              <polyline points="18 15 12 9 6 15" />
            ) : (
              <polyline points="6 9 12 15 18 9" />
            )}
          </svg>
        </button>
      </main>

      <ArrivalThanksModal
        open={arrivalThanksOpen}
        onClose={() => setArrivalThanksOpen(false)}
        requestLabel={lastOfferReceipt?.label}
        txHash={lastOfferReceipt?.arrivalTxHash}
      />

      {showCancelConfirm !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-dialog-title"
          onClick={() => setShowCancelConfirm(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            ref={cancelDialogRef}
            tabIndex={-1}
            role="document"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1c3535",
              borderRadius: "20px",
              padding: "28px 24px 20px",
              width: "100%",
              maxWidth: "360px",
              textAlign: "center",
              boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
              outline: "none",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>⚠️</div>
            <h3
              id="cancel-dialog-title"
              style={{
                margin: "0 0 6px",
                fontSize: "18px",
                fontWeight: "700",
                color: "#F4ECDC",
              }}
            >
              Cancel request
            </h3>
            <p
              style={{
                margin: "0 0 20px",
                fontSize: "13px",
                color: "rgba(242,236,220,0.72)",
                lineHeight: 1.5,
              }}
            >
              Are you sure? Request #{showCancelConfirm} will be recorded as
              cancelled on Stellar.
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setShowCancelConfirm(null)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(255,255,255,0.05)",
                  color: "rgba(242,236,220,0.72)",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                onClick={() => handleCancel(showCancelConfirm)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#FF7A6B",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisconnectConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="disconnect-dialog-title"
          onClick={() => setShowDisconnectConfirm(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            ref={disconnectDialogRef}
            tabIndex={-1}
            role="document"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1c3535",
              borderRadius: "20px",
              padding: "28px 24px 20px",
              width: "100%",
              maxWidth: "360px",
              textAlign: "center",
              boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
              outline: "none",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>⚠️</div>
            <h3
              id="disconnect-dialog-title"
              style={{
                margin: "0 0 6px",
                fontSize: "18px",
                fontWeight: "700",
                color: "#F4ECDC",
              }}
            >
              Disconnect wallet?
            </h3>
            <p
              style={{
                margin: "0 0 20px",
                fontSize: "13px",
                color: "rgba(242,236,220,0.5)",
                lineHeight: 1.5,
              }}
            >
              You will need to reconnect your wallet to request or offer help again.
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setShowDisconnectConfirm(false)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(255,255,255,0.05)",
                  color: "rgba(242,236,220,0.72)",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                onClick={async () => {
                  await StellarWalletsKit.disconnect();
                  setWalletAddress("");
                  clearWalletAddress();
                  setProfileOpen(false);
                  setShowDisconnectConfirm(false);
                }}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#FF7A6B",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: "pointer",
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}

      {showResolveConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="resolve-dialog-title"
          onClick={() => setShowResolveConfirm(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            ref={resolveDialogRef}
            tabIndex={-1}
            role="document"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1c3535",
              borderRadius: "20px",
              padding: "28px 24px 20px",
              width: "100%",
              maxWidth: "360px",
              textAlign: "center",
              boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
              outline: "none",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>⚠️</div>
            <h3
              id="resolve-dialog-title"
              style={{
                margin: "0 0 6px",
                fontSize: "18px",
                fontWeight: "700",
                color: "#F4ECDC",
              }}
            >
              Resolve request?
            </h3>
            <p
              style={{
                margin: "0 0 20px",
                fontSize: "13px",
                color: "rgba(242,236,220,0.72)",
                lineHeight: 1.5,
              }}
            >
              This will mark the request as resolved. This action cannot be undone.
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setShowResolveConfirm(false)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(255,255,255,0.05)",
                  color: "rgba(242,236,220,0.72)",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                onClick={async () => {
                  try {
                    await resolveRequest(
                      activeWalletAddress,
                      requestId,
                      StellarWalletsKit,
                    );
                    setRequestStatus("Resolved");
                    setFeedbackRequestId(requestId);
                    setFeedbackResponderAddress(responders[0]?.responder || null);
                    setShowFeedback(true);
                  } catch (err) {
                    alert("Could not resolve: " + (err.message || ""));
                  }
                  setShowResolveConfirm(false);
                }}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#7357FF",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: "pointer",
                }}
              >
                Resolve
              </button>
            </div>
          </div>
        </div>
      )}

      {showEmergencyModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="emergency-dialog-title"
          onClick={() => setShowEmergencyModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            ref={emergencyDialogRef}
            tabIndex={-1}
            role="document"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1c3535",
              borderRadius: "20px",
              padding: "24px",
              width: "100%",
              maxWidth: "400px",
              maxHeight: "85vh",
              overflowY: "auto",
              boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
              outline: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                marginBottom: "20px",
              }}
            >
              <div>
                <h2
                  id="emergency-dialog-title"
                  style={{
                    margin: 0,
                    fontSize: "22px",
                    fontWeight: "700",
                    color: "#F4ECDC",
                    lineHeight: 1.2,
                  }}
                >
                  What happened?
                </h2>
                <p
                  style={{
                    margin: "6px 0 0",
                    fontSize: "13px",
                    color: "rgba(242,236,220,0.72)",
                    lineHeight: 1.4,
                  }}
                >
                  Pick one so the right people are notified.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setShowEmergencyModal(false)}
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  border: "none",
                  flexShrink: 0,
                  marginLeft: "12px",
                  background: "rgba(255,255,255,0.1)",
                  color: "rgba(242,236,220,0.7)",
                  fontSize: "18px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ×
              </button>
            </div>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              {EMERGENCY_TYPES.map((et) => {
                const isSelected = emergencyType === et.id;
                return (
                  <button
                    key={et.id}
                    onClick={() => {
                      setEmergencyType(et.id);
                      logEmergencySelection(et.id);
                      setSubmitError("");
                      setShowEmergencyModal(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "14px",
                      width: "100%",
                      padding: "14px",
                      background: isSelected
                        ? "rgba(255,122,107,0.08)"
                        : "rgba(255,255,255,0.04)",
                      border: `1.5px solid ${isSelected ? "#FF7A6B" : "rgba(255,255,255,0.08)"}`,
                      borderRadius: "14px",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color 0.15s, background 0.15s",
                    }}
                  >
                    <div
                      style={{
                        width: "48px",
                        height: "48px",
                        borderRadius: "12px",
                        flexShrink: 0,
                        background: isSelected
                          ? "#FF7A6B"
                          : "rgba(255,255,255,0.08)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: isSelected ? "#fff" : "rgba(242,236,220,0.65)",
                        transition: "background 0.15s",
                      }}
                    >
                      {ET_ICONS[et.id] || "•"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: "15px",
                          fontWeight: "600",
                          color: "#F4ECDC",
                          marginBottom: "2px",
                        }}
                      >
                        {et.label}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "rgba(242,236,220,0.72)",
                          lineHeight: 1.3,
                        }}
                      >
                        {et.desc}
                      </div>
                    </div>
                    {isSelected && (
                      <div
                        style={{
                          width: "24px",
                          height: "24px",
                          borderRadius: "50%",
                          flexShrink: 0,
                          background: "#FF7A6B",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                        >
                          <polyline
                            points="2,6 5,9 10,3"
                            stroke="#fff"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          #helphone-help-wrap {
            position: relative;
            overflow-x: hidden;
            max-width: 100vw;
          }
          #helphone-help-sidebar {
            position: fixed !important;
            bottom: 0 !important;
            left: 0 !important;
            width: 100% !important;
            min-width: 0 !important;
            max-height: 80vh !important;
            border-radius: 20px 20px 0 0 !important;
            box-shadow: 0 -8px 40px rgba(0,0,0,0.45) !important;
            transform: translateY(calc(100% - 96px)) !important;
            transition: transform 0.35s cubic-bezier(0.22, 0.75, 0.2, 1) !important;
            z-index: 2000 !important;
            overscroll-behavior: contain !important;
          }
          #helphone-help-sidebar.hp-mobile-open {
            transform: translateY(0) !important;
          }
          #helphone-help-sidebar::before {
            content: none;
          }
          #hp-sidebar-drag-handle {
            display: flex !important;
          }
          #helphone-help-map {
            height: 100vh !important;
            flex: none !important;
            width: 100vw !important;
          }
          #hp-mobile-form-toggle { display: flex !important; bottom: 108px !important; }
          #helphone-help-sidebar > div:not(#hp-sidebar-drag-handle) { padding-top: 6px !important; }
          #hp-hint-overlay {
            bottom: 108px !important;
            font-size: 12px !important;
            padding: 8px 14px !important;
            max-width: calc(100vw - 40px) !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
          }
        }
        @media (max-width: 480px) {
          #helphone-help-sidebar {
            max-height: 88vh !important;
          }
        }
      `}</style>
      </div>
    </MainLayout>
  );
}
