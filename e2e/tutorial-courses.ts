import { availableTutorialSteps } from '../src/app/tutorialCatalog';
import { createTutorialCourses } from '../src/app/tutorialCourse';

// Node has no storage, clipboard or fullscreen, so its default projection
// omits capability-gated steps. Specs run on a secure local Chromium origin.
export const BROWSER_TUTORIAL_COURSES = createTutorialCourses(availableTutorialSteps(['fullscreen', 'clipboard', 'local_storage']));
