import { createContext, useContext } from "react";

const ThemeStorageKeyContext = createContext<string | undefined>(undefined);

export const ThemeStorageKeyProvider = ThemeStorageKeyContext.Provider;

export const useThemeStorageKey = () => useContext(ThemeStorageKeyContext);
