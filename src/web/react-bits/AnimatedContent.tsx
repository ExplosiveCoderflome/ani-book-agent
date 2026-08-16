// Source: React Bits (David Haz), MIT + Commons Clause License Condition v1.0.
// https://github.com/DavidHDev/react-bits
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { gsap } from "gsap";

export default function AnimatedContent({ children, distance = 36, duration = .6, delay = 0, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; distance?: number; duration?: number; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const element = ref.current; if (!element) return; const animation = gsap.fromTo(element, { y: distance, opacity: 0 }, { y: 0, opacity: 1, duration, delay, ease: "power3.out" }); return () => { animation.kill(); }; }, [delay, distance, duration]);
  return <div ref={ref} className={className} {...props}>{children}</div>;
}
