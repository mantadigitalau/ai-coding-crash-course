import {
  CheckCircle2,
  DollarSign,
  GraduationCap,
  Star,
  Users,
} from "lucide-react";
import { StatCard, StatCardSkeleton } from "~/components/stat-card";
import {
  formatCount,
  formatQuizScore,
  formatRating,
  formatShare,
  formatUsd,
} from "~/lib/utils";
import type { CourseMetrics } from "~/services/instructorAnalyticsService";

const GRID_CLASS = "grid gap-4 sm:grid-cols-2 lg:grid-cols-5";

/** The five headline metric cards for one course or a set of courses. */
export function CourseMetricsStats({ metrics }: { metrics: CourseMetrics }) {
  return (
    <div className={GRID_CLASS}>
      <StatCard
        label="Students"
        icon={Users}
        value={String(metrics.students)}
        detail={`+${metrics.studentsLast30Days} in last 30 days`}
      />
      <StatCard
        label="Gross revenue (USD)"
        icon={DollarSign}
        value={formatUsd(metrics.revenueCents)}
        detail={`+${formatUsd(metrics.revenueLast30DaysCents)} in last 30 days`}
      />
      <StatCard
        label="Completion rate"
        icon={CheckCircle2}
        value={formatShare(
          metrics.completion.rate,
          metrics.completion.completed,
          metrics.completion.enrolled
        )}
        detail="Completed ÷ enrolled"
      />
      <StatCard
        label="Avg quiz score"
        icon={GraduationCap}
        value={formatQuizScore(metrics.avgQuizScore.average)}
        detail={`First attempts · ${formatCount(metrics.avgQuizScore.count, "attempt")}`}
      />
      <StatCard
        label="Avg rating"
        icon={Star}
        value={formatRating(metrics.rating.average)}
        detail={formatCount(metrics.rating.count, "rating")}
      />
    </div>
  );
}

export function CourseMetricsStatsSkeleton() {
  return (
    <div className={GRID_CLASS}>
      {Array.from({ length: 5 }).map((_, i) => (
        <StatCardSkeleton key={i} />
      ))}
    </div>
  );
}
