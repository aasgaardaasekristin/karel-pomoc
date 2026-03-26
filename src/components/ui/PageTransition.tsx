import * as React from "react";
import { cn } from "@/lib/utils";

type TransitionDirection = "forward" | "backward" | "fade";

interface PageTransitionProps {
  transitionKey: string;
  direction?: TransitionDirection;
  className?: string;
  children: React.ReactNode;
}

const animationClass: Record<TransitionDirection, string> = {
  forward: "animate-slide-in-right",
  backward: "animate-slide-in-left",
  fade: "animate-fade-in",
};

const PageTransition: React.FC<PageTransitionProps> = ({
  transitionKey,
  direction = "fade",
  className,
  children,
}) => {
  const [display, setDisplay] = React.useState<{
    key: string;
    content: React.ReactNode;
    dir: TransitionDirection;
  }>({ key: transitionKey, content: children, dir: direction });

  const [phase, setPhase] = React.useState<"visible" | "fading">("visible");

  React.useEffect(() => {
    if (transitionKey === display.key) {
      setDisplay((prev) => ({ ...prev, content: children }));
      return;
    }

    setPhase("fading");
    const t = setTimeout(() => {
      setDisplay({ key: transitionKey, content: children, dir: direction });
      setPhase("visible");
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionKey]);

  React.useEffect(() => {
    if (transitionKey === display.key) {
      setDisplay((prev) => ({ ...prev, content: children }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  return (
    <div
      key={display.key}
      className={cn(
        phase === "fading"
          ? "opacity-0 transition-opacity duration-150"
          : animationClass[display.dir],
        className,
      )}
    >
      {display.content}
    </div>
  );
};
PageTransition.displayName = "PageTransition";

export { PageTransition };
export type { PageTransitionProps, TransitionDirection };
