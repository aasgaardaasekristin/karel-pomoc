import { useEffect } from "react";

const EDGE_ZONE_PX = 28;
const MIN_HORIZONTAL_SWIPE_PX = 72;
const MAX_VERTICAL_DRIFT_PX = 56;
const HORIZONTAL_DOMINANCE_RATIO = 1.35;

const isTouchDevice = () => {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
};

const MobileSwipeBack = () => {
  useEffect(() => {
    if (!isTouchDevice()) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }

      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = startX <= EDGE_ZONE_PX;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!tracking || event.changedTouches.length !== 1) return;

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      tracking = false;

      const isHorizontalSwipe = deltaX >= MIN_HORIZONTAL_SWIPE_PX && Math.abs(deltaY) <= MAX_VERTICAL_DRIFT_PX;
      const isDominantHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO;

      if (!isHorizontalSwipe || !isDominantHorizontal) return;

      const backButton = document.querySelector<HTMLElement>("[data-swipe-back='true']");
      backButton?.click();
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, []);

  return null;
};

export default MobileSwipeBack;
