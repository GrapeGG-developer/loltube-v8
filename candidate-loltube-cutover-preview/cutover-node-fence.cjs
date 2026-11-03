'use strict';
/* Startup sentinel for the maintenance-first image. NODE_OPTIONS may require
 * this file so an older image lacking it cannot run. It intentionally neither
 * reads nor writes secrets or user data. Controlled cutover still requires an
 * independently validated final snapshot and gate authorization. */
