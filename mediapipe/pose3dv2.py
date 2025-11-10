import os
import cv2
import numpy as np
import pandas as pd
import mediapipe as mp
from collections import defaultdict
import argparse

# ---------- Tracking helpers ----------

def landmarks_to_numpy(world_landmarks):
    """Convert list[Landmark] -> (33, 3) numpy array."""
    coords = np.array([[lm.x, lm.y, lm.z] for lm in world_landmarks], dtype=np.float32)
    return coords  # shape (33, 3)


def pose_similarity(a, b):
    """
    Average 3D distance (in meters) between two poses.
    a, b: (33, 3) numpy arrays.
    Lower = more similar.
    """
    if a.shape != b.shape:
        return np.inf
    # mean Euclidean distance over all joints
    diff = a - b
    dists = np.linalg.norm(diff, axis=1)
    return float(np.mean(dists))


def match_poses_to_tracks(track_states, pose_arrays, max_dist=0.4):
    """
    Simple greedy matcher between existing tracks and current-frame poses.
    track_states: dict[track_id] -> (coords (33,3), last_seen_frame)
    pose_arrays: list[(33,3)]
    Returns:
        assignments: dict[pose_idx] -> track_id
        new_tracks_needed: list[pose_idx]  (those that didn't match any track)
    """
    if not track_states:
        return {}, list(range(len(pose_arrays)))

    track_ids = list(track_states.keys())
    num_tracks = len(track_ids)
    num_poses = len(pose_arrays)

    # Compute distance matrix [num_tracks x num_poses]
    dist_matrix = np.zeros((num_tracks, num_poses), dtype=np.float32)
    for ti, track_id in enumerate(track_ids):
        track_pose, _ = track_states[track_id]
        for pi, pose in enumerate(pose_arrays):
            dist_matrix[ti, pi] = pose_similarity(track_pose, pose)

    # Greedy: repeatedly pick the smallest distance pair
    assignments = {}
    used_tracks = set()
    used_poses = set()

    while True:
        # Find min unused (track, pose)
        min_val = np.inf
        min_t = None
        min_p = None
        for ti, track_id in enumerate(track_ids):
            if track_id in used_tracks:
                continue
            for pi in range(num_poses):
                if pi in used_poses:
                    continue
                d = dist_matrix[ti, pi]
                if d < min_val:
                    min_val = d
                    min_t = ti
                    min_p = pi

        if min_t is None or min_p is None:
            break

        # If best match is still too far, stop matching
        if min_val > max_dist:
            break

        track_id = track_ids[min_t]
        pose_idx = min_p

        assignments[pose_idx] = track_id
        used_tracks.add(track_id)
        used_poses.add(pose_idx)

    new_tracks = [pi for pi in range(num_poses) if pi not in used_poses]
    return assignments, new_tracks


def color_for_track(track_id):
    """
    Deterministic but varied BGR color for drawing per-track annotations.
    """
    np.random.seed(track_id + 123)
    c = np.random.randint(50, 255, size=3)
    return int(c[0]), int(c[1]), int(c[2])


# ---------- Main processing ----------

def main(input_path, model_path, out_video, out_dir_csv,
         max_poses=4, drop_after_missed=30):

    # MediaPipe Tasks setup (Pose Landmarker, VIDEO mode, multi-pose)
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    BaseOptions = mp.tasks.BaseOptions
    PoseLandmarker = mp.tasks.vision.PoseLandmarker
    PoseLandmarkerOptions = mp.tasks.vision.PoseLandmarkerOptions
    VisionRunningMode = mp.tasks.vision.RunningMode

    base_options = BaseOptions(model_asset_path=model_path)
    options = PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=VisionRunningMode.VIDEO,
        num_poses=max_poses,                     # multi-pose
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        output_segmentation_masks=False
    )

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f"Could not open video: {input_path}")
        return

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = 25.0

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out_writer = cv2.VideoWriter(out_video, fourcc, fps, (width, height))

    os.makedirs(out_dir_csv, exist_ok=True)

    # Tracking state
    next_track_id = 0
    # track_id -> (latest_pose_coords (33,3), last_seen_frame)
    track_states = {}
    # Data per track
    track_rows = defaultdict(list)

    with PoseLandmarker.create_from_options(options) as landmarker:

        frame_idx = 0
        while True:
            success, frame_bgr = cap.read()
            if not success:
                break

            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)

            timestamp_ms = int((frame_idx / fps) * 1000)
            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            pose_world_list = result.pose_world_landmarks  # list of poses
            pose_list = result.pose_landmarks              # image-space landmarks

            pose_arrays = []
            for pose_world in pose_world_list:
                pose_arrays.append(landmarks_to_numpy(pose_world))

            # ---- match to existing tracks ----
            assignments, new_pose_idxs = match_poses_to_tracks(
                track_states, pose_arrays, max_dist=0.4
            )

            # Create new tracks for unassigned poses
            for pi in new_pose_idxs:
                track_id = next_track_id
                next_track_id += 1
                track_states[track_id] = (pose_arrays[pi], frame_idx)
                assignments[pi] = track_id

            # Drop stale tracks (not seen recently)
            tracks_to_drop = []
            for track_id, (_, last_seen) in track_states.items():
                if frame_idx - last_seen > drop_after_missed:
                    tracks_to_drop.append(track_id)
            for track_id in tracks_to_drop:
                del track_states[track_id]

            # ---- recording and drawing ----
            time_s = frame_idx / fps
            annotated = frame_bgr.copy()

            for pose_idx, track_id in assignments.items():
                world_lms = pose_world_list[pose_idx]
                img_lms = pose_list[pose_idx]

                # Update track state
                coords = pose_arrays[pose_idx]
                track_states[track_id] = (coords, frame_idx)

                # Save rows for each landmark
                for lm_id, lm in enumerate(world_lms):
                    track_rows[track_id].append({
                        "frame": frame_idx,
                        "time_s": time_s,
                        "track_id": track_id,
                        "landmark_id": lm_id,
                        "x_m": lm.x,
                        "y_m": lm.y,
                        "z_m": lm.z,
                        "visibility": lm.visibility,
                    })

                # Draw simple skeleton + label for this track
                color = color_for_track(track_id)

                # Compute a bounding box from the 2D landmarks
                xs = [l.x for l in img_lms]
                ys = [l.y for l in img_lms]
                if xs and ys:
                    x_min = int(min(xs) * width)
                    x_max = int(max(xs) * width)
                    y_min = int(min(ys) * height)
                    y_max = int(max(ys) * height)
                    cv2.rectangle(annotated,
                                  (x_min, y_min), (x_max, y_max),
                                  color, 2)
                    cv2.putText(annotated, f"ID {track_id}",
                                (x_min, max(0, y_min - 10)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                                color, 2)

                # Draw keypoints
                for lm in img_lms:
                    cx = int(lm.x * width)
                    cy = int(lm.y * height)
                    cv2.circle(annotated, (cx, cy), 3, color, -1)

            # Global overlay
            cv2.putText(annotated, f"Frame: {frame_idx}", (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
            cv2.putText(annotated, f"Poses: {len(pose_world_list)}", (20, 80),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)

            out_writer.write(annotated)

            # (Optional preview – comment out for headless use)
            cv2.imshow("Multi-pose tracked (MediaPipe Tasks)", annotated)
            if cv2.waitKey(1) & 0xFF == 27:  # ESC
                break

            frame_idx += 1

    cap.release()
    out_writer.release()
    cv2.destroyAllWindows()

    # ---- write one CSV per track ----
    for track_id, rows in track_rows.items():
        df = pd.DataFrame(rows)
        csv_path = os.path.join(out_dir_csv, f"pose3d_track_{track_id}.csv")
        df.to_csv(csv_path, index=False)
        print(f"Track {track_id}: {len(rows)} landmarks rows -> {csv_path}")

    print(f"\nAnnotated video saved to: {os.path.abspath(out_video)}")
    print(f"Per-person CSVs saved under: {os.path.abspath(out_dir_csv)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Multi-person 3D pose with MediaPipe Tasks Pose Landmarker (VIDEO mode) + simple tracking"
    )
    parser.add_argument("--input", "-i", type=str, default="input.mp4",
                        help="Input video path")
    parser.add_argument("--model", "-m", type=str, default="pose_landmarker_full.task",
                        help="Pose Landmarker .task model path")
    parser.add_argument("--out_video", "-ov", type=str, default="multi_pose_tracked.mp4",
                        help="Output annotated video path")
    parser.add_argument("--out_dir_csv", "-oc", type=str, default="pose_tracks_csv",
                        help="Output directory for per-track CSVs")
    parser.add_argument("--max_poses", "-np", type=int, default=4,
                        help="Max number of poses per frame")
    args = parser.parse_args()

    main(args.input, args.model, args.out_video, args.out_dir_csv,
         max_poses=args.max_poses)