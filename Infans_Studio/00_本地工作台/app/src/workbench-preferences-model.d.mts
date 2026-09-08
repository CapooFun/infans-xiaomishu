import type {AppearanceScheme,ThemeId,TextSize} from './workbench-appearance.mjs';
import type {ShortcutBindings} from './workbench-shortcut-bindings.mjs';
export interface SceneCrop {x:number;y:number;image?:string}
export interface DevicePreferences {theme:ThemeId;selected:Record<ThemeId,string>;textSize:TextSize;shortcuts:ShortcutBindings;crops:Record<string,SceneCrop>;pageTextSizes:Record<string,TextSize>}
export function backgroundPosition(crop:SceneCrop|undefined,image:string):string;
export interface PreferencesState {schemaVersion:1;revision:number;schemes:AppearanceScheme[];devices:Record<string,DevicePreferences>}
export interface BackgroundAsset {id:string;name:string;url:string}
export interface PreferencesSnapshot {state:PreferencesState;backgrounds:BackgroundAsset[]}
export function validDeviceId(id:unknown):boolean;
export function emptyPreferences():PreferencesState;
export function defaultDevice(theme?:ThemeId):DevicePreferences;
export function normalizeScheme(raw:unknown,allowedAssets:Set<string>):AppearanceScheme;
export function normalizeDevice(raw:unknown,schemes:AppearanceScheme[]):DevicePreferences;
export function selectedScheme(state:PreferencesState,device:DevicePreferences,theme?:ThemeId):AppearanceScheme;
