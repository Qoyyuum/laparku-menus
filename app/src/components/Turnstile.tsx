export interface TurnstileProps {
  siteKey: string;
  onToken: (token: string) => void;
}

// Native stub — Cloudflare Turnstile is a web-only widget. Native clients
// authenticate the upload with the X-Laparku-Client: app header instead
// (see POST /api/submissions in src/routes/submissions.ts).
export function Turnstile(_props: TurnstileProps) {
  return null;
}
