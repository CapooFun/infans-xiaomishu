import { mountPhoneMacHost, shouldMountPhoneMacHost } from "./phone-mac-view";

if (shouldMountPhoneMacHost()) mountPhoneMacHost();
else await import("./main.tsx");
