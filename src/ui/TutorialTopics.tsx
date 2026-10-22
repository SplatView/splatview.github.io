import { useRef, useState } from 'react';
import { TUTORIAL_COURSES, type TutorialCourseId, type TutorialCourseStep } from '../app/tutorialCourse';
import { useTranslation } from '../app/useLanguageAppearance';

const courseIds = ['essentials', 'all'] as const;

/** Browse presentation topics; only the parent hook changes the active lesson. */
export function TutorialTopics({ id, courseId, step, onSelect }: {
  id: string; courseId: TutorialCourseId; step: TutorialCourseStep;
  onSelect(course: TutorialCourseId, index: number): void;
}) {
  const { t } = useTranslation();
  const [browsing, setBrowsing] = useState(courseId);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const course = TUTORIAL_COURSES[browsing];
  const chapters = [...new Set(course.steps.map(topic => topic.chapter))];
  return <section id={id} className="tutorial-topics" aria-label={t('Topics')}>
    <h1 id={`${id}-title`}>{t('Topics')}</h1>
    <div className="tutorial-course-tabs" role="tablist" aria-label={t('Tutorial')}>
      {courseIds.map((value, index) => <button key={value} ref={element => { tabs.current[index] = element; }}
        id={`${id}-${value}-tab`} type="button" role="tab" aria-selected={browsing === value}
        aria-controls={`${id}-list`} tabIndex={browsing === value ? 0 : -1}
        data-tutorial-initial-focus={browsing === value ? true : undefined}
        onClick={() => setBrowsing(value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          const next = event.key === 'ArrowRight' ? (index + 1) % courseIds.length
            : event.key === 'ArrowLeft' ? (index + courseIds.length - 1) % courseIds.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? courseIds.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); event.stopPropagation();
          setBrowsing(courseIds[next]); tabs.current[next]?.focus({ preventScroll: true });
        }}>{t(TUTORIAL_COURSES[value].label)}</button>)}
    </div>
    <div id={`${id}-list`} role="tabpanel" aria-labelledby={`${id}-${browsing}-tab`}>
      {chapters.map(chapter => <section key={chapter} className="tutorial-topic-group" aria-label={t(chapter)}>
        <h2>{t(chapter)}</h2><ol>
          {course.steps.map((topic, index) => topic.chapter === chapter && <li key={topic.id}>
            <button type="button" data-tutorial-topic-id={topic.id} data-tutorial-topic-course={browsing}
              aria-current={courseId === browsing && step.id === topic.id ? 'step' : undefined}
              onClick={() => onSelect(browsing, index)}>
              <span className="tutorial-topic-number" aria-hidden="true">{index + 1}</span>{t(topic.title)}
            </button>
          </li>)}
        </ol>
      </section>)}
    </div>
  </section>;
}
