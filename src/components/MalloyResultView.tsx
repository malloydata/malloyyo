"use client";
import { useEffect, useRef } from "react";

interface Props {
  stableResult: Record<string, unknown>;
}

export function MalloyResultView({ stableResult }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !stableResult) return;
    const container = containerRef.current;
    let cancelled = false;
    let vizCleanup: (() => void) | null = null;

    import("@malloydata/render").then(({ MalloyRenderer }) => {
      if (cancelled || !container) return;
      const renderer = new MalloyRenderer({});
      const viz = renderer.createViz({
        tableConfig: { enableDrill: false },
        scrollEl: container,
      });
      viz.setResult(stableResult as Parameters<typeof viz.setResult>[0]);
      viz.render(container);
      vizCleanup = () => viz.remove();
    });

    return () => {
      cancelled = true;
      vizCleanup?.();
    };
  }, [stableResult]);

  return (
    <div
      ref={containerRef}
      style={{ display: "grid", minHeight: "350px", overflow: "auto", width: "100%" }}
    />
  );
}
