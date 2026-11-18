import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getInstructorDashboard } from "./instructorAnalyticsService";

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
  createdAt: string = daysBefore(60)
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt })
    .returning()
    .get();
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
});
