import type { Fingerprint } from './types';

// Collects a lightweight client fingerprint + waits briefly for a mouse/touch signal.
export async function collectFingerprint(): Promise<Fingerprint> {
  const nav = navigator as Navigator & { webdriver?: boolean };

  let webglVendor: string | null = null;
  let webglRenderer: string | null = null;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        webglVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
        webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      }
    }
  } catch { /* browser may restrict WebGL */ }

  let mouseMoved = false;
  await new Promise<void>((resolve) => {
    const handler = (): void => { mouseMoved = true; resolve(); };
    window.addEventListener('mousemove', handler, { once: true, passive: true });
    window.addEventListener('touchstart', handler, { once: true, passive: true });
    setTimeout(resolve, 500);
  });

  return {
    webdriver: Boolean(nav.webdriver),
    languages: (() => { try { return Array.from(navigator.languages || []); } catch { return []; } })(),
    hardwareConcurrency: (() => { try { return navigator.hardwareConcurrency || 0; } catch { return 0; } })(),
    screenWidth: (() => { try { return window.screen.width || 0; } catch { return 0; } })(),
    screenHeight: (() => { try { return window.screen.height || 0; } catch { return 0; } })(),
    userAgent: navigator.userAgent,
    webglVendor,
    webglRenderer,
    mouseMoved,
  };
}
