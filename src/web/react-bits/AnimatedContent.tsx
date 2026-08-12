// Source: React Bits (David Haz), MIT + Commons Clause License Condition v1.0.
// https://github.com/DavidHDev/react-bits
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger);

export default function AnimatedContent({ children, distance = 36, duration = .6, delay = 0, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; distance?: number; duration?: number; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const element = ref.current; if (!element) return; gsap.set(element, { y: distance, opacity: 0, visibility: "visible" }); const animation = gsap.to(element, { y: 0, opacity: 1, duration, delay, ease: "power3.out", paused: true }); const trigger = ScrollTrigger.create({ trigger: element, start: "top 92%", once: true, onEnter: () => animation.play() }); return () => { trigger.kill(); animation.kill(); }; }, [delay, distance, duration]);
  return <div ref={ref} className={className} style={{ visibility: "hidden" }} {...props}>{children}</div>;
}
