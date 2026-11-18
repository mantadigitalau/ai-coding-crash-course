import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  DROP_OFF_INACTIVE_DAYS,
  getCourseAnalytics,
  getCourseStudentsWithActivity,
  getInstructorDashboard,
} from "./instructorAnalyticsService";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function daysBefore(days: number) {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

let emailCounter = 0;

function createStudent() {
  emailCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${emailCounter}`,
      email: `student${emailCounter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function createInstructor() {
  emailCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Instructor ${emailCounter}`,
      email: `instructor${emailCounter}@example.com`,
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
}

function createCourse(
  title: string,
  instructorId: number = base.instructor.id,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(
  userId: number,
  courseId: number,
  enrolledAt: string = daysBefore(60),
  completedAt: string | null = null
) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt, completedAt })
    .returning()
    .get();
}

function purchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt: string = daysBefore(60),
  country: string | null = null
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt, country })
    .returning()
    .get();
}

let couponCounter = 0;

/** A team purchase: one purchase row plus a coupon per seat. */
function teamPurchase(
  buyerId: number,
  courseId: number,
  amountPaid: number,
  seats: number,
  redeemedBy: number[] = [],
  country: string | null = null
) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const row = purchase(buyerId, courseId, amountPaid, daysBefore(20), country);
  for (let i = 0; i < seats; i++) {
    couponCounter++;
    const redeemer = redeemedBy[i] ?? null;
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `SEAT-${couponCounter}`,
        purchaseId: row.id,
        redeemedByUserId: redeemer,
        redeemedAt: redeemer === null ? null : daysBefore(10),
      })
      .run();
  }
  return row;
}

function createQuiz(courseId: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
}

function attempt(
  userId: number,
  quizId: number,
  score: number,
  attemptedAt: string
) {
  return testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed: score > 0.7, attemptedAt })
    .returning()
    .get();
}

function rate(userId: number, courseId: number, rating: number) {
  return testDb
    .insert(schema.courseRatings)
    .values({ userId, courseId, rating })
    .returning()
    .get();
}

/** Adds a module at `position` with lessons titled `titles`, in order. */
function createModule(courseId: number, position: number, titles: string[]) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${position}`, position })
    .returning()
    .get();
  return titles.map((title, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title, position: i + 1 })
      .returning()
      .get()
  );
}

function completeLesson(userId: number, lessonId: number, completedAt: string) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt,
    })
    .run();
}

function watchVideo(userId: number, lessonId: number, createdAt: string) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({ userId, lessonId, eventType: "play", positionSeconds: 0, createdAt })
    .run();
}

function studentRow(
  roster: ReturnType<typeof getCourseStudentsWithActivity>,
  userId: number
) {
  const row = roster.students.find((s) => s.userId === userId);
  if (!row) throw new Error(`No student row for user ${userId}`);
  return row;
}

function rowFor(
  dashboard: ReturnType<typeof getInstructorDashboard>,
  courseId: number
) {
  const row = dashboard.courses.find((c) => c.id === courseId);
  if (!row) throw new Error(`No row for course ${courseId}`);
  return row;
}

describe("instructorAnalyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorDashboard", () => {
    it("lists every course the instructor owns, of every status", () => {
      const draft = createCourse("Draft Course", base.instructor.id, schema.CourseStatus.Draft);
      const archived = createCourse(
        "Archived Course",
        base.instructor.id,
        schema.CourseStatus.Archived
      );

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(
        dashboard.courses.map((c) => ({ id: c.id, status: c.status })).sort((a, b) => a.id - b.id)
      ).toEqual([
        { id: base.course.id, status: schema.CourseStatus.Published },
        { id: draft.id, status: schema.CourseStatus.Draft },
        { id: archived.id, status: schema.CourseStatus.Archived },
      ]);
    });

    it("never includes another instructor's courses or numbers", () => {
      const other = createInstructor();
      const otherCourse = createCourse("Other Course", other.id);
      const student = createStudent();
      enroll(student.id, otherCourse.id, daysBefore(5), daysBefore(1));
      purchase(student.id, otherCourse.id, 5000, daysBefore(5));
      rate(student.id, otherCourse.id, 5);
      const quiz = createQuiz(otherCourse.id);
      attempt(student.id, quiz.id, 0.9, daysBefore(2));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(dashboard.courses.map((c) => c.id)).toEqual([base.course.id]);
      expect(dashboard.totals).toEqual({
        students: 0,
        studentsLast30Days: 0,
        revenueCents: 0,
        revenueLast30DaysCents: 0,
        completion: { rate: null, completed: 0, enrolled: 0 },
        avgQuizScore: { average: null, count: 0 },
        rating: { average: null, count: 0 },
      });
    });

    it("counts enrolled students and those enrolled in the last 30 days", () => {
      const second = createCourse("Second Course");
      enroll(createStudent().id, base.course.id, daysBefore(45));
      enroll(createStudent().id, base.course.id, daysBefore(10));
      enroll(createStudent().id, second.id, daysBefore(29));
      enroll(createStudent().id, second.id, daysBefore(31));
      enroll(createStudent().id, second.id, daysBefore(90));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(dashboard.totals.students).toBe(5);
      expect(dashboard.totals.studentsLast30Days).toBe(2);
      expect(rowFor(dashboard, base.course.id).students).toBe(2);
      expect(rowFor(dashboard, base.course.id).studentsLast30Days).toBe(1);
      expect(rowFor(dashboard, second.id).students).toBe(3);
      expect(rowFor(dashboard, second.id).studentsLast30Days).toBe(1);
    });

    it("sums gross revenue and revenue from the last 30 days", () => {
      const second = createCourse("Second Course");
      const buyer = createStudent();
      purchase(buyer.id, base.course.id, 4999, daysBefore(80));
      purchase(buyer.id, base.course.id, 2500, daysBefore(3));
      // A team purchase is one row whose amount covers every seat.
      purchase(buyer.id, second.id, 15000, daysBefore(12));
      purchase(buyer.id, second.id, 1000, daysBefore(31));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(dashboard.totals.revenueCents).toBe(23499);
      expect(dashboard.totals.revenueLast30DaysCents).toBe(17500);
      expect(rowFor(dashboard, base.course.id).revenueCents).toBe(7499);
      expect(rowFor(dashboard, second.id).revenueCents).toBe(16000);
      expect(rowFor(dashboard, second.id).revenueLast30DaysCents).toBe(15000);
    });

    it("reports completion as completed ÷ enrolled, null with no enrollments", () => {
      const second = createCourse("Second Course");
      const empty = createCourse("Empty Course");
      enroll(createStudent().id, base.course.id, daysBefore(40), daysBefore(5));
      enroll(createStudent().id, base.course.id, daysBefore(40));
      enroll(createStudent().id, base.course.id, daysBefore(40));
      enroll(createStudent().id, second.id, daysBefore(40), daysBefore(2));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(rowFor(dashboard, base.course.id).completion).toEqual({
        rate: 1 / 3,
        completed: 1,
        enrolled: 3,
      });
      expect(rowFor(dashboard, empty.id).completion).toEqual({
        rate: null,
        completed: 0,
        enrolled: 0,
      });
      expect(dashboard.totals.completion).toEqual({
        rate: 0.5,
        completed: 2,
        enrolled: 4,
      });
    });

    it("averages each student's first attempt per quiz, ignoring retakes", () => {
      const second = createCourse("Second Course");
      const quizA = createQuiz(base.course.id);
      const quizB = createQuiz(second.id);
      const alice = createStudent();
      const bob = createStudent();

      // Alice retakes quiz A: only the 0.4 counts. Insert the retake first to
      // prove ordering is by attempt date, not insertion order.
      attempt(alice.id, quizA.id, 1.0, daysBefore(5));
      attempt(alice.id, quizA.id, 0.4, daysBefore(10));
      // Two attempts at the same instant: the earlier row wins.
      attempt(bob.id, quizA.id, 0.6, daysBefore(8));
      attempt(bob.id, quizA.id, 0.9, daysBefore(8));
      attempt(bob.id, quizB.id, 0.8, daysBefore(4));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      const rowA = rowFor(dashboard, base.course.id).avgQuizScore;
      expect(rowA.count).toBe(2);
      expect(rowA.average).toBeCloseTo(0.5);
      expect(rowFor(dashboard, second.id).avgQuizScore).toEqual({
        average: 0.8,
        count: 1,
      });
      // Pooled over all three student × quiz first attempts.
      expect(dashboard.totals.avgQuizScore.count).toBe(3);
      expect(dashboard.totals.avgQuizScore.average).toBeCloseTo(0.6);
    });

    it("reports average rating with its count, pooled across courses", () => {
      const second = createCourse("Second Course");
      const unrated = createCourse("Unrated Course");
      rate(createStudent().id, base.course.id, 5);
      rate(createStudent().id, base.course.id, 4);
      rate(createStudent().id, second.id, 2);

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(rowFor(dashboard, base.course.id).rating).toEqual({
        average: 4.5,
        count: 2,
      });
      expect(rowFor(dashboard, unrated.id).rating).toEqual({
        average: null,
        count: 0,
      });
      // (5 + 4 + 2) / 3 = 3.67, not the 3.25 average of course averages.
      expect(dashboard.totals.rating).toEqual({ average: 3.7, count: 3 });
    });
  });
  describe("getCourseAnalytics", () => {
    it("reports the same headline stats as the course's dashboard row", () => {
      const other = createCourse("Other Course");
      const alice = createStudent();
      const bob = createStudent();
      enroll(alice.id, base.course.id, daysBefore(40), daysBefore(5));
      enroll(bob.id, base.course.id, daysBefore(10));
      enroll(bob.id, other.id, daysBefore(10));
      purchase(alice.id, base.course.id, 4999, daysBefore(40));
      purchase(bob.id, base.course.id, 2500, daysBefore(10));
      purchase(bob.id, other.id, 9999, daysBefore(10));
      const quiz = createQuiz(base.course.id);
      attempt(alice.id, quiz.id, 0.5, daysBefore(9));
      attempt(alice.id, quiz.id, 1.0, daysBefore(8));
      attempt(bob.id, quiz.id, 0.9, daysBefore(7));
      rate(alice.id, base.course.id, 4);
      rate(bob.id, other.id, 1);

      const analytics = getCourseAnalytics(base.course.id, NOW);

      expect(analytics.headline).toEqual({
        students: 2,
        studentsLast30Days: 1,
        revenueCents: 7499,
        revenueLast30DaysCents: 2500,
        completion: { rate: 0.5, completed: 1, enrolled: 2 },
        avgQuizScore: { average: 0.7, count: 2 },
        rating: { average: 4, count: 1 },
      });
      const { id: _id, title: _t, slug: _s, status: _st, ...row } = rowFor(
        getInstructorDashboard(base.instructor.id, NOW),
        base.course.id
      );
      expect(analytics.headline).toEqual(row);
    });

    it("splits revenue into individual and team purchases", () => {
      const buyer = createStudent();
      purchase(buyer.id, base.course.id, 4999);
      purchase(createStudent().id, base.course.id, 2500);
      teamPurchase(buyer.id, base.course.id, 15000, 3);
      // Another course's team purchase doesn't count here.
      teamPurchase(buyer.id, createCourse("Other Course").id, 80000, 2);

      const { revenue } = getCourseAnalytics(base.course.id, NOW);

      expect(revenue.individualCents).toBe(7499);
      expect(revenue.teamCents).toBe(15000);
    });

    it("splits revenue into full price and PPP by purchase country", () => {
      const buyer = createStudent();
      purchase(buyer.id, base.course.id, 4999, daysBefore(5), "US");
      purchase(buyer.id, base.course.id, 3000, daysBefore(5), null);
      purchase(buyer.id, base.course.id, 2500, daysBefore(5), "IN");
      purchase(buyer.id, base.course.id, 1500, daysBefore(5), "ng");
      teamPurchase(buyer.id, base.course.id, 10000, 2, [], "BR");

      const { revenue, headline } = getCourseAnalytics(base.course.id, NOW);

      expect(revenue.fullPriceCents).toBe(7999);
      expect(revenue.pppCents).toBe(14000);
      expect(revenue.fullPriceCents + revenue.pppCents).toBe(
        headline.revenueCents
      );
      expect(revenue.individualCents + revenue.teamCents).toBe(
        headline.revenueCents
      );
    });

    it("counts every purchase as full price when the course has PPP disabled", () => {
      const course = testDb
        .update(schema.courses)
        .set({ pppEnabled: false })
        .where(eq(schema.courses.id, base.course.id))
        .returning()
        .get();
      const buyer = createStudent();
      purchase(buyer.id, course.id, 4999, daysBefore(5), "IN");
      purchase(buyer.id, course.id, 4999, daysBefore(5), "US");

      const { revenue } = getCourseAnalytics(course.id, NOW);

      expect(revenue.fullPriceCents).toBe(9998);
      expect(revenue.pppCents).toBe(0);
    });

    it("counts team seats sold and redeemed, without counting seats as students", () => {
      const buyer = createStudent();
      const alice = createStudent();
      const bob = createStudent();
      teamPurchase(buyer.id, base.course.id, 15000, 3, [alice.id]);
      teamPurchase(buyer.id, base.course.id, 10000, 2, [bob.id]);
      enroll(alice.id, base.course.id);
      enroll(bob.id, base.course.id);
      teamPurchase(buyer.id, createCourse("Other Course").id, 5000, 4, [alice.id]);

      const { seats, headline } = getCourseAnalytics(base.course.id, NOW);

      expect(seats).toEqual({ sold: 5, redeemed: 2 });
      expect(headline.students).toBe(2);
    });

    it("reports zero seats when there are no team purchases", () => {
      purchase(createStudent().id, base.course.id, 4999);

      expect(getCourseAnalytics(base.course.id, NOW).seats).toEqual({
        sold: 0,
        redeemed: 0,
      });
    });
  });

  describe("getCourseStudentsWithActivity", () => {
    it("takes the latest of lesson completion, quiz attempt and video watch as last activity", () => {
      const [lesson] = createModule(base.course.id, 2, ["Intro"]);
      const quiz = createQuiz(base.course.id);
      const byLesson = createStudent();
      const byQuiz = createStudent();
      const byVideo = createStudent();
      const idle = createStudent();
      for (const s of [byLesson, byQuiz, byVideo, idle]) {
        enroll(s.id, base.course.id);
      }
      completeLesson(byLesson.id, lesson.id, daysBefore(3));
      attempt(byLesson.id, quiz.id, 0.5, daysBefore(9));
      watchVideo(byLesson.id, lesson.id, daysBefore(8));

      completeLesson(byQuiz.id, lesson.id, daysBefore(9));
      attempt(byQuiz.id, quiz.id, 0.5, daysBefore(2));
      watchVideo(byQuiz.id, lesson.id, daysBefore(8));

      completeLesson(byVideo.id, lesson.id, daysBefore(9));
      attempt(byVideo.id, quiz.id, 0.5, daysBefore(8));
      watchVideo(byVideo.id, lesson.id, daysBefore(1));

      // Activity in another course doesn't count.
      const [otherLesson] = createModule(createCourse("Other Course").id, 1, ["X"]);
      watchVideo(idle.id, otherLesson.id, daysBefore(1));

      const roster = getCourseStudentsWithActivity(base.course.id);

      expect(studentRow(roster, byLesson.id).lastActivityAt).toBe(daysBefore(3));
      expect(studentRow(roster, byQuiz.id).lastActivityAt).toBe(daysBefore(2));
      expect(studentRow(roster, byVideo.id).lastActivityAt).toBe(daysBefore(1));
      expect(studentRow(roster, idle.id).lastActivityAt).toBeNull();
    });

    it("keeps the roster's existing columns: identity, dates, progress and best score per quiz", () => {
      const [l1, l2] = createModule(base.course.id, 1, ["One", "Two"]);
      const [l3, l4] = createModule(base.course.id, 2, ["Three", "Four"]);
      const quizA = testDb
        .insert(schema.quizzes)
        .values({ lessonId: l2.id, title: "Quiz A", passingScore: 0.7 })
        .returning()
        .get();
      const quizB = testDb
        .insert(schema.quizzes)
        .values({ lessonId: l4.id, title: "Quiz B", passingScore: 0.7 })
        .returning()
        .get();
      const alice = createStudent();
      const bob = createStudent();
      enroll(alice.id, base.course.id, daysBefore(30), daysBefore(2));
      enroll(bob.id, base.course.id, daysBefore(20));
      for (const lesson of [l1, l2, l3, l4]) {
        completeLesson(alice.id, lesson.id, daysBefore(3));
      }
      completeLesson(bob.id, l1.id, daysBefore(5));
      attempt(alice.id, quizA.id, 0.5, daysBefore(6));
      attempt(alice.id, quizA.id, 0.9, daysBefore(5));
      attempt(alice.id, quizA.id, 0.6, daysBefore(4));
      attempt(alice.id, quizB.id, 0.4, daysBefore(4));
      // An in-progress lesson doesn't count towards progress.
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: bob.id,
          lessonId: l2.id,
          status: schema.LessonProgressStatus.InProgress,
        })
        .run();

      const roster = getCourseStudentsWithActivity(base.course.id);

      expect(roster.quizCount).toBe(2);
      expect(roster.students.map((s) => s.userId)).toEqual([alice.id, bob.id]);
      expect(studentRow(roster, alice.id)).toMatchObject({
        name: alice.name,
        email: alice.email,
        enrolledAt: daysBefore(30),
        completedAt: daysBefore(2),
        progress: 100,
        quizScores: [
          { quizId: quizA.id, quizTitle: "Quiz A", lessonTitle: "Two", bestScore: 0.9, passed: true },
          { quizId: quizB.id, quizTitle: "Quiz B", lessonTitle: "Four", bestScore: 0.4, passed: false },
        ],
      });
      expect(studentRow(roster, bob.id)).toMatchObject({
        completedAt: null,
        progress: 25,
        quizScores: [
          { quizId: quizA.id, bestScore: null, passed: null },
          { quizId: quizB.id, bestScore: null, passed: null },
        ],
      });
    });

    it("reports zero progress and no quizzes for a course without lessons", () => {
      const alice = createStudent();
      enroll(alice.id, base.course.id);

      const roster = getCourseStudentsWithActivity(base.course.id);

      expect(roster.quizCount).toBe(0);
      expect(studentRow(roster, alice.id)).toMatchObject({
        progress: 0,
        quizScores: [],
        lastActivityAt: null,
      });
    });
  });

  describe("getCourseAnalytics dropOffLessons", () => {
    it("counts a student as dropped off once their last activity is 14 or more days ago", () => {
      expect(DROP_OFF_INACTIVE_DAYS).toBe(14);
      const [l1, l2] = createModule(base.course.id, 1, ["One", "Two"]);
      const exactly14 = createStudent();
      const justUnder14 = createStudent();
      enroll(exactly14.id, base.course.id);
      enroll(justUnder14.id, base.course.id);
      completeLesson(exactly14.id, l1.id, daysBefore(14));
      completeLesson(justUnder14.id, l1.id, daysBefore(20));
      // A later video watch keeps this student active.
      watchVideo(
        justUnder14.id,
        l2.id,
        new Date(NOW.getTime() - 14 * 86_400_000 + 1).toISOString()
      );

      const { dropOffLessons } = getCourseAnalytics(base.course.id, NOW);

      expect(dropOffLessons).toEqual([
        { lessonId: l2.id, lessonTitle: "Two", students: 1 },
      ]);
    });

    it("excludes students who completed the course, however long ago", () => {
      const [l1] = createModule(base.course.id, 1, ["One", "Two"]);
      const finished = createStudent();
      enroll(finished.id, base.course.id, daysBefore(90), daysBefore(60));
      completeLesson(finished.id, l1.id, daysBefore(60));

      expect(getCourseAnalytics(base.course.id, NOW).dropOffLessons).toEqual([]);
    });

    it("attributes the drop-off to the next lesson in course order, across module boundaries", () => {
      // Module 2 is inserted first to prove ordering uses positions, not ids.
      const [m2l1] = createModule(base.course.id, 2, ["Module 2 Lesson 1"]);
      const [, m1l2] = createModule(base.course.id, 1, ["M1 L1", "M1 L2"]);
      const student = createStudent();
      enroll(student.id, base.course.id);
      completeLesson(student.id, m1l2.id, daysBefore(30));

      expect(getCourseAnalytics(base.course.id, NOW).dropOffLessons).toEqual([
        { lessonId: m2l1.id, lessonTitle: "Module 2 Lesson 1", students: 1 },
      ]);
    });

    it("uses the furthest completed lesson in course order, not the most recent", () => {
      const [l1, l2, l3] = createModule(base.course.id, 1, ["One", "Two", "Three"]);
      const student = createStudent();
      enroll(student.id, base.course.id);
      completeLesson(student.id, l2.id, daysBefore(40));
      completeLesson(student.id, l1.id, daysBefore(30));

      expect(getCourseAnalytics(base.course.id, NOW).dropOffLessons).toEqual([
        { lessonId: l3.id, lessonTitle: "Three", students: 1 },
      ]);
    });

    it("puts a student with no completed lessons at the first lesson, using their enrollment date when they have no activity", () => {
      const [first] = createModule(base.course.id, 1, ["First", "Second"]);
      const longAgo = createStudent();
      const recent = createStudent();
      enroll(longAgo.id, base.course.id, daysBefore(30));
      enroll(recent.id, base.course.id, daysBefore(3));

      expect(getCourseAnalytics(base.course.id, NOW).dropOffLessons).toEqual([
        { lessonId: first.id, lessonTitle: "First", students: 1 },
      ]);
    });

    it("attributes a student who completed the final lesson but skipped one to the first lesson they skipped", () => {
      const [l1, l2, l3] = createModule(base.course.id, 1, ["One", "Two", "Three"]);
      const student = createStudent();
      enroll(student.id, base.course.id);
      completeLesson(student.id, l1.id, daysBefore(30));
      completeLesson(student.id, l3.id, daysBefore(30));

      expect(getCourseAnalytics(base.course.id, NOW).dropOffLessons).toEqual([
        { lessonId: l2.id, lessonTitle: "Two", students: 1 },
      ]);
    });

    it("returns the top 3 lessons by student count, ties in course order", () => {
      const lessons = createModule(base.course.id, 1, ["A", "B", "C", "D", "E"]);
      // Drop-offs: A×1, B×2, C×1, D×3, E×0. C's student is enrolled before
      // A's, so the A-over-C tie-break must come from course order.
      const plan: [number, number][] = [
        [2, 1],
        [3, 3],
        [1, 2],
        [0, 1],
      ];
      for (const [index, count] of plan) {
        for (let i = 0; i < count; i++) {
          const student = createStudent();
          enroll(student.id, base.course.id, daysBefore(60));
          for (const lesson of lessons.slice(0, index)) {
            completeLesson(student.id, lesson.id, daysBefore(30));
          }
        }
      }

      expect(getCourseAnalytics(base.course.id, NOW).dropOffLessons).toEqual([
        { lessonId: lessons[3].id, lessonTitle: "D", students: 3 },
        { lessonId: lessons[1].id, lessonTitle: "B", students: 2 },
        { lessonId: lessons[0].id, lessonTitle: "A", students: 1 },
      ]);
    });
  });
});
