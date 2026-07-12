"use client";

import { BrandMark } from "@/components/brand-mark";
import { LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Review" },
  { href: "/people", label: "Search" },
  { href: "/signals", label: "Sources" },
  { href: "/settings", label: "Settings" },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="top-nav" aria-label="Primary navigation">
      <Link className="brand-lockup" href="/" aria-label="Unfound home">
        <span className="brand-mark"><BrandMark /></span>
        <span>Unfound</span>
      </Link>

      <ul className="nav-links">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              aria-current={
                (link.href === "/" ? pathname === "/" : pathname.startsWith(link.href))
                  ? "page"
                  : undefined
              }
              data-active={
                link.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(link.href)
              }
              href={link.href}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>

      <div className="nav-actions">
        <form action="/api/auth/logout" method="post">
          <button className="nav-icon-button" type="submit" aria-label="Log out">
            <LogOut aria-hidden="true" size={15} />
          </button>
        </form>
      </div>
    </nav>
  );
}
