#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { reminderMessage, showMacNotification } from "../src/security-reminder.mjs";
import { readSecurityReview } from "../src/security-review.mjs";

const config = loadConfig();
const status = await readSecurityReview(config.stateDirectory);
const message = reminderMessage(status);
if (message) await showMacNotification(message);
