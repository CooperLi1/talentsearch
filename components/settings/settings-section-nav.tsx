"use client";

import { useEffect, useRef, useState } from "react";

const sections = [
  { description: "Who and what matters", id: "target", label: "Target profile", number: "01" },
  { description: "Evidence threshold", id: "quality", label: "Quality cutoff", number: "02" },
  { description: "Schedule and recipients", id: "digest", label: "Brief delivery", number: "03" },
  { description: "Discovery inputs", id: "sources", label: "Source coverage", number: "04" },
  { description: "Learning behavior", id: "adaptation", label: "Review preferences", number: "05" },
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
      <div className="settings-nav-heading">
        <span>Control stack</span>
        <p>Five decisions shape every review queue.</p>
      </div>
      {sections.map(({ description, id, label, number }) => (
        <a
          aria-current={activeSection === id ? "location" : undefined}
          data-active={activeSection === id}
          href={`#${id}`}
          key={id}
          onClick={() => setActiveSection(id)}
        >
          <span className="settings-nav-number">{number}</span>
          <span className="settings-nav-copy">
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
        </a>
      ))}
    </nav>
  );
}
