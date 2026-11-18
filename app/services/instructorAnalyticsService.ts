import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  quizAnswers,
  quizAttempts,
  quizOptions,
  quizQuestions,
  quizzes,
  users,
  videoWatchEvents,
  type CourseStatus,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";

// ─── Instructor Analytics Service ───
// Owns every instructor analytics definition (students, revenue, completion,
// quiz scores, ratings). Aggregates run as grouped SQL over a set of courses,
// never as a query per course. Values that can't be computed are null.
// Uses positional parameters (project convention).

const RECENT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** A share with the counts behind it. `rate` is 0..1, null when enrolled is 0. */
export type CompletionRate = {
  rate: number | null;
  completed: number;
  enrolled: number;
};

/** Average first-attempt quiz score (0..1) over `count` student × quiz pairs. */
export type QuizScoreAverage = {
  average: number | null;
  count: number;
};

/** Average star rating (1dp) over `count` ratings. */
export type RatingAverage = {
  average: number | null;
  count: number;
};

export type CourseMetrics = {
  students: number;
  studentsLast30Days: number;
  revenueCents: number;
  revenueLast30DaysCents: number;
  completion: CompletionRate;
  avgQuizScore: QuizScoreAverage;
  rating: RatingAverage;
};

export type DashboardCourseRow = CourseMetrics & {
  id: number;
  title: string;
  slug: string;
  status: CourseStatus;
};

export type InstructorDashboard = {
  totals: CourseMetrics;
  courses: DashboardCourseRow[];
};

// Additive per-course sums. Totals across courses are sums of these, which
// gives pooled (not average-of-averages) quiz scores and ratings.
type MetricSums = {
  students: number;
  studentsRecent: number;
  completed: number;
  revenueCents: number;
  revenueRecentCents: number;
  quizScoreSum: number;
  quizScoreCount: number;
  ratingSum: number;
  ratingCount: number;
};

function emptySums(): MetricSums {
  return {
    students: 0,
    studentsRecent: 0,
    completed: 0,
    revenueCents: 0,
    revenueRecentCents: 0,
    quizScoreSum: 0,
    quizScoreCount: 0,
    ratingSum: 0,
    ratingCount: 0,
  };
}

function addSums(a: MetricSums, b: MetricSums): MetricSums {
  const out = emptySums();
  for (const key of Object.keys(out) as (keyof MetricSums)[]) {
    out[key] = a[key] + b[key];
  }
  return out;
}

function toMetrics(sums: MetricSums): CourseMetrics {
  return {
    students: sums.students,
    studentsLast30Days: sums.studentsRecent,
    revenueCents: sums.revenueCents,
    revenueLast30DaysCents: sums.revenueRecentCents,
    completion: {
      rate: sums.students === 0 ? null : sums.completed / sums.students,
      completed: sums.completed,
      enrolled: sums.students,
    },
    avgQuizScore: {
      average:
        sums.quizScoreCount === 0
          ? null
          : sums.quizScoreSum / sums.quizScoreCount,
      count: sums.quizScoreCount,
    },
    rating: {
      average:
        sums.ratingCount === 0
          ? null
          : Math.round((sums.ratingSum / sums.ratingCount) * 10) / 10,
      count: sums.ratingCount,
    },
  };
}

/**
 * Each student's first attempt at each quiz in `courseIds`, as a subquery with
 * `courseId`, `quizId`, `userId`, `score` and `passed`. "First" is the earliest
 * `attemptedAt`, ties broken by id.
 */
function firstQuizAttempts(courseIds: number[]) {
  const ranked = db
    .select({
      courseId: modules.courseId,
      quizId: quizAttempts.quizId,
      userId: quizAttempts.userId,
      score: quizAttempts.score,
      passed: quizAttempts.passed,
      attemptRank: sql<number>`row_number() over (partition by ${quizAttempts.userId}, ${quizAttempts.quizId} order by ${quizAttempts.attemptedAt}, ${quizAttempts.id})`.as(
        "attempt_rank"
      ),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(inArray(modules.courseId, courseIds))
    .as("ranked_attempts");

  return db
    .select({
      courseId: ranked.courseId,
      quizId: ranked.quizId,
      userId: ranked.userId,
      score: ranked.score,
      passed: ranked.passed,
    })
    .from(ranked)
    .where(eq(ranked.attemptRank, 1))
    .as("first_attempts");
}

/**
 * Metric sums for each of `courseIds`, from one grouped query per metric.
 * Callers are responsible for scoping `courseIds` to what the viewer may see.
 */
function getMetricSumsByCourse(
  courseIds: number[],
  now: Date
): Map<number, MetricSums> {
  const sums = new Map<number, MetricSums>();
  for (const id of courseIds) sums.set(id, emptySums());
  if (courseIds.length === 0) return sums;

  const recentCutoff = new Date(
    now.getTime() - RECENT_WINDOW_DAYS * DAY_MS
  ).toISOString();

  const enrollmentRows = db
    .select({
      courseId: enrollments.courseId,
      students: sql<number>`count(*)`,
      studentsRecent: sql<number>`coalesce(sum(case when ${enrollments.enrolledAt} >= ${recentCutoff} then 1 else 0 end), 0)`,
      completed: sql<number>`coalesce(sum(case when ${enrollments.completedAt} is not null then 1 else 0 end), 0)`,
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.courseId)
    .all();

  for (const row of enrollmentRows) {
    const s = sums.get(row.courseId)!;
    s.students = row.students;
    s.studentsRecent = row.studentsRecent;
    s.completed = row.completed;
  }

  const revenueRows = db
    .select({
      courseId: purchases.courseId,
      revenueCents: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
      revenueRecentCents: sql<number>`coalesce(sum(case when ${purchases.createdAt} >= ${recentCutoff} then ${purchases.amountPaid} else 0 end), 0)`,
    })
    .from(purchases)
    .where(inArray(purchases.courseId, courseIds))
    .groupBy(purchases.courseId)
    .all();

  for (const row of revenueRows) {
    const s = sums.get(row.courseId)!;
    s.revenueCents = row.revenueCents;
    s.revenueRecentCents = row.revenueRecentCents;
  }

  const firstAttempts = firstQuizAttempts(courseIds);
  const quizRows = db
    .select({
      courseId: firstAttempts.courseId,
      scoreSum: sql<number>`coalesce(sum(${firstAttempts.score}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(firstAttempts)
    .groupBy(firstAttempts.courseId)
    .all();

  for (const row of quizRows) {
    const s = sums.get(row.courseId)!;
    s.quizScoreSum = row.scoreSum;
    s.quizScoreCount = row.count;
  }

  const ratingRows = db
    .select({
      courseId: courseRatings.courseId,
      ratingSum: sql<number>`coalesce(sum(${courseRatings.rating}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .where(inArray(courseRatings.courseId, courseIds))
    .groupBy(courseRatings.courseId)
    .all();

  for (const row of ratingRows) {
    const s = sums.get(row.courseId)!;
    s.ratingSum = row.ratingSum;
    s.ratingCount = row.count;
  }

  return sums;
}

/**
 * Overview of every course the instructor owns (any status), with totals
 * across them. Scoped by `courses.instructorId`, so another instructor's
 * courses and numbers never appear.
 */
export function getInstructorDashboard(
  instructorId: number,
  now: Date = new Date()
): InstructorDashboard {
  const owned = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      status: courses.status,
    })
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .orderBy(asc(courses.title))
    .all();

  const sumsByCourse = getMetricSumsByCourse(
    owned.map((c) => c.id),
    now
  );

  let totals = emptySums();
  const rows = owned.map((course) => {
    const sums = sumsByCourse.get(course.id)!;
    totals = addSums(totals, sums);
    return { ...course, ...toMetrics(sums) };
  });

  return { totals: toMetrics(totals), courses: rows };
}

/**
 * Analytics for one course. Each section is its own top-level field, so a new
 * section is one more field. The caller is responsible for checking the viewer
 * may see `courseId` (owner or admin).
 */
export type CourseAnalytics = {
  headline: CourseMetrics;
  revenue: RevenueBreakdown;
  seats: TeamSeats;
  quizInsights: QuizInsights;
  dropOffLessons: DropOffLesson[];
};

/** Gross revenue split two ways; each pair sums to the course's gross revenue. */
export type RevenueBreakdown = {
  individualCents: number;
  teamCents: number;
  fullPriceCents: number;
  pppCents: number;
};

/**
 * A purchase is a team purchase when team seat coupons are attached to it.
 * It is PPP when the course has PPP enabled and the purchase's stored country
 * gets a discount; otherwise (including no country) it is full price.
 */
function getRevenueBreakdown(
  courseId: number,
  pppEnabled: boolean
): RevenueBreakdown {
  const teamPurchaseIds = db
    .select({ id: coupons.purchaseId })
    .from(coupons)
    .where(eq(coupons.courseId, courseId));
  const isTeam = sql<number>`${inArray(purchases.id, teamPurchaseIds)}`;
  const rows = db
    .select({
      isTeam,
      country: purchases.country,
      cents: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
    })
    .from(purchases)
    .where(eq(purchases.courseId, courseId))
    .groupBy(isTeam, purchases.country)
    .all();

  const breakdown: RevenueBreakdown = {
    individualCents: 0,
    teamCents: 0,
    fullPriceCents: 0,
    pppCents: 0,
  };
  for (const row of rows) {
    if (row.isTeam) breakdown.teamCents += row.cents;
    else breakdown.individualCents += row.cents;

    if (pppEnabled && getDiscountForCountry(row.country) > 0) {
      breakdown.pppCents += row.cents;
    } else {
      breakdown.fullPriceCents += row.cents;
    }
  }
  return breakdown;
}

export function getCourseAnalytics(
  courseId: number,
  now: Date = new Date()
): CourseAnalytics {
  const course = db
    .select({ pppEnabled: courses.pppEnabled })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  const sums = getMetricSumsByCourse([courseId], now).get(courseId)!;
  return {
    headline: toMetrics(sums),
    revenue: getRevenueBreakdown(courseId, course?.pppEnabled ?? false),
    seats: getTeamSeats(courseId),
    quizInsights: getQuizInsights(courseId),
    dropOffLessons: getDropOffLessons(courseId, now),
  };
}

/** Team seats: sold = coupons created for the course; redeemed = coupons with a redeemer. */
export type TeamSeats = {
  sold: number;
  redeemed: number;
};

function getTeamSeats(courseId: number): TeamSeats {
  const row = db
    .select({
      sold: sql<number>`count(*)`,
      redeemed: sql<number>`count(${coupons.redeemedByUserId})`,
    })
    .from(coupons)
    .where(eq(coupons.courseId, courseId))
    .get();
  return { sold: row?.sold ?? 0, redeemed: row?.redeemed ?? 0 };
}

/** A share of students with the counts behind it; `rate` is null when `attempted` is 0. */
export type PassRate = {
  rate: number | null;
  passed: number;
  attempted: number;
};

export type QuizStats = {
  quizId: number;
  title: string;
  /** Average of each student's first-attempt score (0..1). */
  firstAttemptScore: QuizScoreAverage;
  /** Students whose first attempt passed, out of students who attempted. */
  firstAttemptPass: PassRate;
  /** Students with any passing attempt, out of students who attempted. */
  eventualPass: PassRate;
};

export type HardQuestion = {
  questionId: number;
  quizTitle: string;
  questionText: string;
  /** correct ÷ answers, 0..1. */
  correctRate: number;
  correct: number;
  answers: number;
  /** Text of the wrong option chosen most often; null when nobody chose a wrong one. */
  mostCommonWrongOption: string | null;
};

export type QuizInsights = {
  /** Every quiz in the course, in course order, including unattempted ones. */
  quizzes: QuizStats[];
  /** Up to 3 questions with the lowest % correct over all recorded answers. */
  hardestQuestions: HardQuestion[];
};

const HARDEST_QUESTION_LIMIT = 3;
const HARDEST_QUESTION_MIN_ANSWERS = 5;

function passRate(passed: number, attempted: number): PassRate {
  return {
    rate: attempted === 0 ? null : passed / attempted,
    passed,
    attempted,
  };
}

function getQuizInsights(courseId: number): QuizInsights {
  const courseQuizzes = db
    .select({ id: quizzes.id, title: quizzes.title })
    .from(quizzes)
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.position), asc(lessons.position), asc(quizzes.id))
    .all();

  const firstAttempts = firstQuizAttempts([courseId]);
  const firstRows = db
    .select({
      quizId: firstAttempts.quizId,
      scoreSum: sql<number>`coalesce(sum(${firstAttempts.score}), 0)`,
      passed: sql<number>`coalesce(sum(case when ${firstAttempts.passed} then 1 else 0 end), 0)`,
      attempted: sql<number>`count(*)`,
    })
    .from(firstAttempts)
    .groupBy(firstAttempts.quizId)
    .all();
  const firstByQuiz = new Map(firstRows.map((r) => [r.quizId, r]));

  const quizIds = courseQuizzes.map((q) => q.id);
  const eventualRows =
    quizIds.length === 0
      ? []
      : db
          .select({
            quizId: quizAttempts.quizId,
            passed: sql<number>`count(distinct case when ${quizAttempts.passed} then ${quizAttempts.userId} end)`,
            attempted: sql<number>`count(distinct ${quizAttempts.userId})`,
          })
          .from(quizAttempts)
          .where(inArray(quizAttempts.quizId, quizIds))
          .groupBy(quizAttempts.quizId)
          .all();
  const eventualByQuiz = new Map(eventualRows.map((r) => [r.quizId, r]));

  return {
    quizzes: courseQuizzes.map((quiz) => {
      const first = firstByQuiz.get(quiz.id);
      const eventual = eventualByQuiz.get(quiz.id);
      const attempted = first?.attempted ?? 0;
      return {
        quizId: quiz.id,
        title: quiz.title,
        firstAttemptScore: {
          average: attempted === 0 ? null : first!.scoreSum / attempted,
          count: attempted,
        },
        firstAttemptPass: passRate(first?.passed ?? 0, attempted),
        eventualPass: passRate(eventual?.passed ?? 0, eventual?.attempted ?? 0),
      };
    }),
    hardestQuestions: getHardestQuestions(quizIds),
  };
}

/**
 * The questions in `quizIds` with the lowest share of correct answers, across
 * every recorded answer (all attempts). Questions with fewer than 5 answers
 * are left out. Ties go to the question with more answers, then lower id.
 */
function getHardestQuestions(quizIds: number[]): HardQuestion[] {
  if (quizIds.length === 0) return [];

  const correct = sql<number>`coalesce(sum(case when ${quizOptions.isCorrect} then 1 else 0 end), 0)`;
  const answers = sql<number>`count(*)`;
  const hardest = db
    .select({
      questionId: quizQuestions.id,
      quizTitle: quizzes.title,
      questionText: quizQuestions.questionText,
      correct,
      answers,
    })
    .from(quizAnswers)
    .innerJoin(quizQuestions, eq(quizQuestions.id, quizAnswers.questionId))
    .innerJoin(quizzes, eq(quizzes.id, quizQuestions.quizId))
    .innerJoin(quizOptions, eq(quizOptions.id, quizAnswers.selectedOptionId))
    .where(inArray(quizQuestions.quizId, quizIds))
    .groupBy(quizQuestions.id)
    .having(sql`${answers} >= ${HARDEST_QUESTION_MIN_ANSWERS}`)
    .orderBy(
      sql`cast(${correct} as real) / ${answers}`,
      sql`${answers} desc`,
      asc(quizQuestions.id)
    )
    .limit(HARDEST_QUESTION_LIMIT)
    .all();

  // Wrong-option counts for just those questions, most chosen first (ties:
  // the option listed first), so the first row per question is the answer.
  const wrongRows =
    hardest.length === 0
      ? []
      : db
          .select({
            questionId: quizAnswers.questionId,
            optionText: quizOptions.optionText,
          })
          .from(quizAnswers)
          .innerJoin(
            quizOptions,
            eq(quizOptions.id, quizAnswers.selectedOptionId)
          )
          .where(
            and(
              inArray(
                quizAnswers.questionId,
                hardest.map((q) => q.questionId)
              ),
              eq(quizOptions.isCorrect, false)
            )
          )
          .groupBy(quizAnswers.questionId, quizOptions.id)
          .orderBy(sql`count(*) desc`, asc(quizOptions.id))
          .all();
  const wrongByQuestion = new Map<number, string>();
  for (const row of wrongRows) {
    if (!wrongByQuestion.has(row.questionId)) {
      wrongByQuestion.set(row.questionId, row.optionText);
    }
  }

  return hardest.map((q) => ({
    ...q,
    correctRate: q.correct / q.answers,
    mostCommonWrongOption: wrongByQuestion.get(q.questionId) ?? null,
  }));
}

// ─── Student activity ───

/** Each student's last activity in a course, keyed by user id. */
type LastActivity = Map<number, string>;

/**
 * Latest of lesson completion, quiz attempt and video watch event per student,
 * within `courseId`. ISO strings compare correctly as text.
 */
function getLastActivityByUser(courseId: number): LastActivity {
  const lessonCompletions = db
    .select({
      userId: lessonProgress.userId,
      at: sql<string | null>`max(${lessonProgress.completedAt})`,
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .groupBy(lessonProgress.userId)
    .all();
  const quizAttemptTimes = db
    .select({
      userId: quizAttempts.userId,
      at: sql<string | null>`max(${quizAttempts.attemptedAt})`,
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .groupBy(quizAttempts.userId)
    .all();
  const videoWatchTimes = db
    .select({
      userId: videoWatchEvents.userId,
      at: sql<string | null>`max(${videoWatchEvents.createdAt})`,
    })
    .from(videoWatchEvents)
    .innerJoin(lessons, eq(lessons.id, videoWatchEvents.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .groupBy(videoWatchEvents.userId)
    .all();

  const latest: LastActivity = new Map();
  for (const row of [
    ...lessonCompletions,
    ...quizAttemptTimes,
    ...videoWatchTimes,
  ]) {
    if (row.at === null) continue;
    const current = latest.get(row.userId);
    if (current === undefined || row.at > current) {
      latest.set(row.userId, row.at);
    }
  }
  return latest;
}

export type StudentQuizScore = {
  quizId: number;
  quizTitle: string;
  lessonTitle: string;
  bestScore: number | null;
  passed: boolean | null;
};

export type StudentWithActivity = {
  userId: number;
  name: string;
  email: string;
  enrolledAt: string;
  completedAt: string | null;
  /** Share of the course's lessons completed, 0..100 (rounded). */
  progress: number;
  /** Best attempt per quiz in course order; nulls when not attempted. */
  quizScores: StudentQuizScore[];
  /** Latest lesson completion, quiz attempt or video watch; null when none. */
  lastActivityAt: string | null;
};

export type CourseStudentsWithActivity = {
  students: StudentWithActivity[];
  quizCount: number;
};

/**
 * The students page's roster: every enrolled student with progress, best score
 * per quiz and last activity, from a fixed number of queries however many
 * students are enrolled. The caller checks the viewer may see `courseId`.
 */
export function getCourseStudentsWithActivity(
  courseId: number
): CourseStudentsWithActivity {
  const roster = db
    .select({
      userId: enrollments.userId,
      name: users.name,
      email: users.email,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
    })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(eq(enrollments.courseId, courseId))
    .orderBy(asc(enrollments.id))
    .all();

  const lastActivity = getLastActivityByUser(courseId);
  const lessonCount = getLessonsInCourseOrder(courseId).length;
  const completedByUser = getCompletedLessonIdsByUser(courseId);

  const courseQuizzes = db
    .select({
      quizId: quizzes.id,
      quizTitle: quizzes.title,
      lessonTitle: lessons.title,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.position), asc(lessons.position), asc(quizzes.id))
    .all();

  const bestAttempts = getBestQuizAttempts(courseId);

  return {
    students: roster.map((student) => {
      const completed = completedByUser.get(student.userId)?.size ?? 0;
      return {
        ...student,
        progress:
          lessonCount === 0 ? 0 : Math.round((completed / lessonCount) * 100),
        quizScores: courseQuizzes.map((quiz) => {
          const best = bestAttempts.get(`${student.userId}:${quiz.quizId}`);
          return {
            ...quiz,
            bestScore: best?.score ?? null,
            passed: best?.passed ?? null,
          };
        }),
        lastActivityAt: lastActivity.get(student.userId) ?? null,
      };
    }),
    quizCount: courseQuizzes.length,
  };
}

/** The course's lessons in course order: module position, then lesson position. */
function getLessonsInCourseOrder(courseId: number) {
  return db
    .select({ id: lessons.id, title: lessons.title })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.position), asc(lessons.position), asc(lessons.id))
    .all();
}

/** Ids of the lessons each student has completed in `courseId`. */
function getCompletedLessonIdsByUser(courseId: number) {
  const rows = db
    .select({ userId: lessonProgress.userId, lessonId: lessonProgress.lessonId })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(
      and(
        eq(modules.courseId, courseId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .all();

  const byUser = new Map<number, Set<number>>();
  for (const row of rows) {
    let set = byUser.get(row.userId);
    if (!set) byUser.set(row.userId, (set = new Set()));
    set.add(row.lessonId);
  }
  return byUser;
}

/**
 * Each student's highest-scoring attempt per quiz in `courseId`, keyed
 * `${userId}:${quizId}`. Ties go to the earlier attempt.
 */
function getBestQuizAttempts(courseId: number) {
  const ranked = db
    .select({
      userId: quizAttempts.userId,
      quizId: quizAttempts.quizId,
      score: quizAttempts.score,
      passed: quizAttempts.passed,
      attemptRank: sql<number>`row_number() over (partition by ${quizAttempts.userId}, ${quizAttempts.quizId} order by ${quizAttempts.score} desc, ${quizAttempts.id})`.as(
        "attempt_rank"
      ),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .as("ranked_best_attempts");

  const rows = db
    .select({
      userId: ranked.userId,
      quizId: ranked.quizId,
      score: ranked.score,
      passed: ranked.passed,
    })
    .from(ranked)
    .where(eq(ranked.attemptRank, 1))
    .all();

  return new Map(rows.map((row) => [`${row.userId}:${row.quizId}`, row]));
}

// ─── Drop-off ───

/** Days without activity after which a student who hasn't completed has dropped off. */
export const DROP_OFF_INACTIVE_DAYS = 14;
const DROP_OFF_LESSON_LIMIT = 3;

/** A lesson where `students` dropped-off students stopped. */
export type DropOffLesson = {
  lessonId: number;
  lessonTitle: string;
  students: number;
};

/**
 * Top lessons where students dropped off, most students first (ties in course
 * order). A student has dropped off when their enrollment isn't complete and
 * their last activity (or, with none, their enrollment date) is
 * DROP_OFF_INACTIVE_DAYS or more before `now`. They stopped at the lesson after
 * their furthest completed lesson in course order; with none completed, at the
 * first lesson. When that furthest lesson is the last one but gaps remain, they
 * stopped at the first lesson they haven't completed.
 */
function getDropOffLessons(courseId: number, now: Date): DropOffLesson[] {
  const courseLessons = getLessonsInCourseOrder(courseId);
  if (courseLessons.length === 0) return [];

  const cutoff = new Date(
    now.getTime() - DROP_OFF_INACTIVE_DAYS * DAY_MS
  ).toISOString();
  const incomplete = db
    .select({ userId: enrollments.userId, enrolledAt: enrollments.enrolledAt })
    .from(enrollments)
    .where(
      and(eq(enrollments.courseId, courseId), isNull(enrollments.completedAt))
    )
    .all();
  const lastActivity = getLastActivityByUser(courseId);
  const completedByUser = getCompletedLessonIdsByUser(courseId);

  const countsByIndex = new Map<number, number>();
  for (const student of incomplete) {
    const last = lastActivity.get(student.userId) ?? student.enrolledAt;
    if (last > cutoff) continue;

    const completed = completedByUser.get(student.userId) ?? new Set<number>();
    let furthest = -1;
    courseLessons.forEach((lesson, i) => {
      if (completed.has(lesson.id)) furthest = i;
    });
    let index = furthest + 1;
    if (index >= courseLessons.length) {
      index = courseLessons.findIndex((lesson) => !completed.has(lesson.id));
      if (index === -1) continue; // every lesson done; nowhere to stop
    }
    countsByIndex.set(index, (countsByIndex.get(index) ?? 0) + 1);
  }

  return [...countsByIndex.entries()]
    .sort(([indexA, a], [indexB, b]) => b - a || indexA - indexB)
    .slice(0, DROP_OFF_LESSON_LIMIT)
    .map(([index, students]) => ({
      lessonId: courseLessons[index].id,
      lessonTitle: courseLessons[index].title,
      students,
    }));
}
