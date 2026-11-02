/** False when this browser cannot draw 3D; the dashboard then shows the flat flow map. */
export function canDraw3d(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}
