import { create } from 'zustand';

/** Which tool is open once connected */
export type Screen = 'home' | 'click' | 'live';

interface AppState {
  screen: Screen;
  setScreen: (screen: Screen) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  screen: 'home',
  setScreen: (screen) => set({ screen }),
}));
