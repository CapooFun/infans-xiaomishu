import { BookOpenText } from "lucide-react";
import "./course-shelf.css";

export type CourseShelfItem = {
  id: string;
  topicId: string;
  title: string;
  subtitle: string;
  status: string;
  version: string;
  createdAt: string;
  language: string;
  topics: string[];
  bytes: number;
  modifiedAt: string;
  pdfUrl: string;
  coverUrl: string | null;
};

export type CourseShelfResponse = {
  available: boolean;
  courses: CourseShelfItem[];
  warnings: string[];
};

function statusLabel(status: string) {
  if (status === "trial") return "试作课";
  if (status === "ready" || status === "complete") return "正式课件";
  return status || "课件";
}

function bytesLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "PDF";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function TopicCourseShelf({ courses }: { courses: CourseShelfItem[] }) {
  if (!courses.length) return null;
  return (
    <section className="topic-course-shelf" aria-labelledby="topic-course-shelf-title">
      <h3 id="topic-course-shelf-title">课件附件 <span>{courses.length}</span></h3>
      <div className="topic-course-list">
        {courses.map((course) => (
          <div className="topic-course-card" key={course.id}>
            <div className="topic-course-cover">
              {course.coverUrl ? <img src={course.coverUrl} alt=""/> : <span aria-hidden="true">{course.title.slice(0, 1)}</span>}
            </div>
            <div className="topic-course-copy">
              <span>{statusLabel(course.status)} · {bytesLabel(course.bytes)}</span>
              <h4>{course.title}</h4>
              <a className="topic-course-open" href={course.pdfUrl} download aria-label={`下载课件：${course.title}`} title="下载课件"><BookOpenText size={18}/></a>
            </div>
          </div>
      ))}
      </div>
    </section>
  );
}
