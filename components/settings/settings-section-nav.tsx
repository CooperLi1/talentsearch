"use client";

import { useEffect, useRef, useState } from "react";

const sections = [
  { id: "target", label: "Target profile" },
  { id: "quality", label: "Quality cutoff" },
  { id: "digest", label: "Brief delivery" },
  { id: "sources", label: "Source coverage" },
  { id: "adaptation", label: "Review preferences" },
] as const;

export function SettingsSectionNav() {
  const [activeSection, setActiveSection] = useState<(typeof sections)[number]["id"]>("target");
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const elements = sections
      .map(({ id }) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);

    if (!elements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        const id = visible[0]?.target.id as (typeof sections)[number]["id"] | undefined;
        if (id) setActiveSection(id);
      },
      {
        rootMargin: "-104px 0px -68% 0px",
        threshold: [0, 0.01],
      },
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const activeLink = navRef.current?.querySelector<HTMLAnchorElement>(
      `[href="#${activeSection}"]`,
    );
    if (!activeLink || !window.matchMedia("(max-width: 820px)").matches) return;

    activeLink.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [activeSection]);

  return (
    <nav className="settings-nav" aria-label="Settings sections" ref={navRef}>
      {sections.map(({ id, label }) => (
        <a
          aria-current={activeSection === id ? "location" : undefined}
          data-active={activeSection === id}
          href={`#${id}`}
          key={id}
          onClick={() => setActiveSection(id)}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
