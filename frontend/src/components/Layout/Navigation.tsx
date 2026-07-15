import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import type { ReactNode } from "react";
import { Button } from "../ui";
import { Archive, ArrowRightLeft, Mail, PlugZap, Repeat } from "lucide-react";

interface NavItemProps {
  to: string;
  icon: ReactNode;
  label: string;
  isActive: boolean;
}

function NavItem({ to, icon, label, isActive }: NavItemProps) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-2 px-1 pt-1 border-b-2 text-sm font-medium py-3 ${
        isActive
          ? "border-neutral-800 text-neutral-800"
          : "border-transparent text-neutral-400 hover:text-neutral-700"
      }`}
    >
      {icon}
      {label}
    </Link>
  );
}

const navItems = [
  { to: "/", icon: <Mail className="size-4" />, label: "Mail Accounts" },
  {
    to: "/automation-flows",
    icon: <Repeat className="size-4" />,
    label: "Automation Flows",
  },
  {
    to: "/migration",
    icon: <ArrowRightLeft className="size-4" />,
    label: "Migration",
  },
  {
    to: "/archive",
    icon: <Archive className="size-4" />,
    label: "Archive",
  },
  {
    to: "/connection-test",
    icon: <PlugZap className="size-4" />,
    label: "Connection Test",
  },
];

export default function Navigation() {
  const location = useLocation();
  const { logout } = useAuth();

  // Clearing the session makes the AuthGate swap to the login page in place
  const handleLogout = async () => {
    await logout();
  };

  return (
    <nav className="bg-white shadow-sm border-b border-neutral-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="shrink-0 flex items-center gap-2">
            <img src="/icon.svg" alt="autoMail" className="size-8" />
            <h1 className="text-xl font-bold text-neutral-900">autoMail</h1>
          </div>
          <div className="flex items-center">
            <Button variant="primary" onClick={handleLogout}>
              Logout
            </Button>
          </div>
        </div>
        <div className="flex space-x-4">
          {navItems.map((item) => (
            <NavItem
              key={item.to}
              to={item.to}
              icon={item.icon}
              label={item.label}
              isActive={location.pathname === item.to}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
