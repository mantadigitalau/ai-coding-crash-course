import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
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
