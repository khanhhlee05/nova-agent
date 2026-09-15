import { Moon, Sun } from "lucide-react";
import type { Theme } from "../theme";
import { Tip } from "./Tip";

export type ThemeSwitchProps = { theme: Theme; onChange: (theme: Theme) => void; onField?: boolean };

/** Two-state segmented control. Both options are always visible so the switch never hides the alternative. */
export const ThemeSwitch = ({ theme, onChange, onField = false }: ThemeSwitchProps) => (
  <div className="theme-switch" role="group" aria-label="Theme" data-on-field={onField}>
    <Tip label="Light theme">
      <button type="button" className="theme-option" aria-pressed={theme === "light"} aria-label="Light theme" onClick={() => onChange("light")}>
        <Sun size={15} aria-hidden="true" />
      </button>
    </Tip>
    <Tip label="Dark theme">
      <button type="button" className="theme-option" aria-pressed={theme === "dark"} aria-label="Dark theme" onClick={() => onChange("dark")}>
        <Moon size={15} aria-hidden="true" />
      </button>
    </Tip>
  </div>
);
