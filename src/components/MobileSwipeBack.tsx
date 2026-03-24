import { useEffect } from "react";

const EDGE_ZONE_PX = 18;
const MIN_HORIZONTAL_SWIPE_PX = 108;
const MAX_VERTICAL_DRIFT_PX = 36;
const MAX_GESTURE_DURATION_MS = 450;
const HORIZONTAL_DOMINANCE_RATIO = 1.8;

const isTouchDevice = () => {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
};

const isInteractiveTarget = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, a, input, textarea, select, label, [role='button'], [data-no-swipe-back='true']"));
};

const MobileSwipeBack = () => {
  useEffect(() => {
    if (!isTouchDevice()) return;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;
    let blocked = false;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        blocked = false;
        return;
      }

      const touch = event.touches[0];
      const target = event.target as Element | null;

      // Check for lock on any ancestor of the touch target
      const lock = target?.closest("[data-swipe-back-lock='true']");

      startX = touch.clientX;
      startY = touch.clientY;
      startTime = Date.now();
      blocked = Boolean(lock) || isInteractiveTarget(event.target);
      tracking = startX <= EDGE_ZONE_PX && !blocked;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;

      const touch = event.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      if (Math.abs(deltaY) > MAX_VERTICAL_DRIFT_PX || deltaX < -12) {
        tracking = false;
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!tracking || blocked || event.changedTouches.length !== 1) return;

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const duration = Date.now() - startTime;

      tracking = false;
      blocked = false;

      const isFastEnough = duration <= MAX_GESTURE_DURATION_MS;
      const isHorizontalSwipe = deltaX >= MIN_HORIZONTAL_SWIPE_PX && Math.abs(deltaY) <= MAX_VERTICAL_DRIFT_PX;
      const isDominantHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO;

      if (!isFastEnough || !isHorizontalSwipe || !isDominantHorizontal) return;

      // SCOPED: find the closest swipe-back button relative to where the touch started
      // Walk up from the touch target to find the most specific back button
      const startTarget = event.target as Element | null;
      if (!startTarget) return;

      // Find closest back button — NO global fallback to prevent accidental navigation
      const backButton = startTarget.closest("[data-swipe-back='true']");

      if (backButton instanceof HTMLElement) {
        backButton.click();
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, []);

  return null;
};

export default MobileSwipeBack;
